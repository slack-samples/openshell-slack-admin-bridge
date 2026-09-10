import "dotenv/config";
import { App, LogLevel } from "@slack/bolt";
import type { BlockAction, ButtonAction } from "@slack/bolt";
import type { View } from "@slack/types";
import { loadConfig } from "./config";
import { OpenShellClient } from "./openshell-client";
import { StateStore } from "./state-store";
import { Poller } from "./poller";
import {
  ACTION_APPROVE,
  ACTION_REJECT,
  ACTION_OPEN_REQUEST,
  ACTION_VIEW_DECISIONS,
  REJECT_MODAL_CALLBACK,
  REJECT_REASON_BLOCK,
  REJECT_REASON_INPUT,
  parseRejectMetadata,
} from "./slack-messages";
import { DecisionService, type SlackSurface } from "./decision-service";
import { childLogger } from "./logger";
import { diag, DiagCode, diagStartup, safeError } from "./diagnostics";

const log = childLogger("index");

// How often to re-run terminal-record pruning on a long-lived process (in addition to
// a prune at startup). Pruning is O(records) and cheap, so a few hours is ample.
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Adapt Bolt's Web API client to the narrow SlackSurface the decision logic needs.
function boltSurface(app: App): SlackSurface {
  return {
    postMessage: async ({ channel, text, blocks }) => {
      // Suppress link unfurls: the cards carry egress hostnames we do not want expanded in-channel.
      const res = await app.client.chat.postMessage({ channel, text, blocks, unfurl_links: false });
      return { ts: res.ts, channel: (res.channel as string | undefined) ?? channel };
    },
    updateMessage: async ({ channel, ts, text, blocks }) => {
      await app.client.chat.update({ channel, ts, text, blocks });
    },
    getPermalink: async ({ channel, messageTs }) => {
      const res = await app.client.chat.getPermalink({ channel, message_ts: messageTs });
      return res.permalink as string | undefined;
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  // Record a non-identifying environment fingerprint at the top of every diagnostics file, so
  // any support bundle carries version/OS/config-shape context for triage.
  diagStartup(config);

  const client = new OpenShellClient(
    config.openshell.gatewayUrl,
    config.openshell.auth,
    config.defaultWorkspace,
  );
  const store = new StateStore(config.statePath);

  const app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: config.logLevel === "debug" ? LogLevel.DEBUG : LogLevel.INFO,
  });

  const svc = new DecisionService(config, client, store, boltSurface(app));

  // Publish the richest App Home view this deployment's Slack will accept for `userId`, peeling
  // off the least-proven block first so a single rejected block never blanks the Home tab: the
  // native data_visualization charts (the block most likely to be rejected), then the newer KPI
  // `table`, then the carousel. Once charts are dropped they stay dropped in every deeper tier, so
  // a charts-only rejection keeps the carousel and KPI table and loses only the Analytics section.
  // Each tier is only attempted if the richer one was rejected; a blank Home tab is the worst
  // outcome. Called on app_home_opened and again after every decision: a card acted on from the
  // Home tab must reflect its new terminal state at once, and unlike the channel card (updated by
  // the decision itself) the published Home view is not refreshed unless we re-publish it here.
  const publishHome = async (userId: string): Promise<void> => {
    const tiers: Array<{ opts: { carousel?: boolean; kpiTable?: boolean; charts?: boolean }; label: string }> = [
      { opts: {}, label: "modern (carousel + KPI table + native charts)" },
      { opts: { charts: false }, label: "analytics dropped (charts rejected)" },
      { opts: { charts: false, kpiTable: false }, label: "analytics dropped + KPI strip (table rejected)" },
      { opts: { charts: false, carousel: false }, label: "GA-only fallback (carousel rejected)" },
    ];
    for (let i = 0; i < tiers.length; i++) {
      try {
        await app.client.views.publish({ user_id: userId, view: svc.homeViewFor(userId, tiers[i].opts) });
        if (i > 0) log.info(`App Home published via ${tiers[i].label}.`);
        return;
      } catch (err) {
        if (i === tiers.length - 1) {
          log.error({ err }, "Failed to publish App Home (all fallback tiers exhausted).");
          diag(DiagCode.AppHomePublishFailed, { err: safeError(err) });
        } else {
          log.warn({ err }, `App Home publish failed at "${tiers[i].label}"; retrying with the next fallback.`);
        }
      }
    }
  };

  // --- Poller ---------------------------------------------------------------

  const poller = new Poller(client, store, config.pollIntervalMs, config.pollConcurrency);
  svc.attachPoller(poller);
  poller.on("poll_error", (err) => log.warn({ err }, "Poll cycle error."));

  // --- Approve button -------------------------------------------------------

  app.action<BlockAction<ButtonAction>>(ACTION_APPROVE, async ({ ack, body, action, respond }) => {
    await ack();
    const result = await svc.approve(body.user.id, action.value);
    if (!result.ok) {
      await respond({ response_type: "ephemeral", text: result.message });
      return;
    }
    // Re-publish the acting user's Home tab so a card approved from it shows terminal state at
    // once. Harmless for a channel-message approval (it just refreshes that admin's queue).
    await publishHome(body.user.id);
  });

  // --- Reject button opens a modal -----------------------------------------

  app.action<BlockAction<ButtonAction>>(ACTION_REJECT, async ({ ack, body, action, client: web, respond }) => {
    await ack();
    const modal = svc.rejectModalFor(body.user.id, action.value);
    if (!modal.ok) {
      await respond({ response_type: "ephemeral", text: modal.message });
      return;
    }
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;
    await web.views.open({ trigger_id: triggerId, view: modal.view });
  });

  // --- Open-request deep link (App Home carousel cards) --------------------
  // The button carries a `url`, so Slack opens the channel request itself; we only need to ack
  // the interaction so Bolt does not log it as unhandled.
  app.action<BlockAction<ButtonAction>>(ACTION_OPEN_REQUEST, async ({ ack }) => {
    await ack();
  });

  // --- Analytics: "Approvals vs rejections" modal --------------------------
  // The Home Analytics button opens a modal detailing the decision history (lifetime + windowed
  // counts, a per-day breakdown, decision latency, breakdowns by reviewer/sandbox/rule, and a
  // decision trail). The modal is chartless and built from GA blocks - data_visualization does not
  // render in modal views, only in messages and on Home tabs - so views.open never rejects it for a
  // chart. This action fires only from the Home tab, whose block_actions payload carries a
  // trigger_id but NO response_url, so Bolt attaches no `respond` here; a not-authorized result
  // (only a stale client, since the button renders for admins alone) surfaces through a small error
  // modal rather than an ephemeral we could not post.
  app.action<BlockAction<ButtonAction>>(ACTION_VIEW_DECISIONS, async ({ ack, body, client: web }) => {
    await ack();
    const triggerId = (body as { trigger_id?: string }).trigger_id;
    if (!triggerId) return;
    const modal = svc.decisionsModalFor(body.user.id);
    const view: View = modal.ok
      ? modal.view
      : {
          type: "modal",
          title: { type: "plain_text", text: "Approvals vs rejections" },
          close: { type: "plain_text", text: "Close" },
          blocks: [{ type: "section", text: { type: "mrkdwn", text: `:lock: ${modal.message}` } }],
        };
    try {
      await web.views.open({ trigger_id: triggerId, view });
    } catch (err) {
      log.error({ err }, "Decisions modal open failed.");
      diag(DiagCode.AppHomePublishFailed, { err: safeError(err) });
    }
  });

  // --- Reject modal submission ---------------------------------------------

  app.view(REJECT_MODAL_CALLBACK, async ({ ack, body, view, client: web }) => {
    const userId = body.user.id;
    const meta = parseRejectMetadata(view.private_metadata);
    const reason = (view.state.values[REJECT_REASON_BLOCK]?.[REJECT_REASON_INPUT]?.value ?? "").trim();

    // Inline modal errors must be surfaced synchronously on ack.
    const invalid = svc.validateRejectSubmission(userId, reason);
    if (invalid) {
      await ack({ response_action: "errors", errors: { [invalid.block]: invalid.error } });
      return;
    }
    await ack();

    const result = await svc.reject(userId, meta.chunkId, reason);
    // Surface only actionable failures back to the approver; "unknown"/"already_decided"
    // are benign races that the message state already reflects.
    if (!result.ok && (result.code === "in_flight" || result.code === "error") && meta.channelId) {
      await web.chat.postEphemeral({ channel: meta.channelId, user: userId, text: result.message });
    }
    // Re-publish the acting user's Home tab so a card rejected from it shows terminal state at once.
    if (result.ok) await publishHome(userId);
  });

  // --- App Home -------------------------------------------------------------

  app.event("app_home_opened", async ({ event }) => {
    await publishHome(event.user);
  });

  app.error(async (err) => {
    log.error({ err }, "Unhandled Bolt error.");
    diag(DiagCode.BoltUnhandled, { err: safeError(err) });
  });

  await app.start();
  log.info("Slack Admin Bridge started (Socket Mode).");
  await svc.reconcile();
  poller.start();

  // Optional terminal-record retention. When STATE_RETENTION_DAYS is unset this stays
  // off entirely (keep forever). Otherwise prune once at startup, then on a slow timer.
  let pruneTimer: NodeJS.Timeout | undefined;
  if (config.stateRetentionDays !== undefined) {
    const maxAgeMs = config.stateRetentionDays * 24 * 60 * 60 * 1000;
    const prune = () => {
      const removed = store.pruneTerminal(maxAgeMs);
      if (removed > 0) {
        log.info({ removed, retentionDays: config.stateRetentionDays }, "Pruned expired terminal records.");
      }
    };
    prune();
    pruneTimer = setInterval(prune, PRUNE_INTERVAL_MS);
    pruneTimer.unref(); // pruning must never keep the process alive on its own
    log.info({ retentionDays: config.stateRetentionDays }, "Terminal-record retention enabled.");
  }

  const shutdown = () => {
    log.info("Shutting down.");
    poller.stop();
    if (pruneTimer) clearInterval(pruneTimer);
    client.close();
    void app.stop().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log.error({ err }, "Fatal startup error.");
  diag(DiagCode.StartupFatal, { err: safeError(err) });
  process.exit(1);
});
