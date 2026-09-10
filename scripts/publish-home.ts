/**
 * One-shot App Home publisher for live verification of the native data_visualization charts.
 *
 * Publishes the admin's App Home view exactly as the bridge's publishHome() does (same tier
 * ladder), but as a single views.publish call over the real @slack/web-api WebClient, with no
 * Socket Mode and no OpenShell gateway (the charts are built from durable decision history, and
 * with zero pending chunks the pending-detail cache is unused). Its whole job is to answer the
 * one thing that can't be checked offline: does this workspace's App Home now ACCEPT
 * data_visualization, or does the ladder still fall back?
 *
 * The bot token is read ONLY from SLACK_BOT_TOKEN and is never written to disk or logged. Run
 * with the sandbox disabled (api.slack.com is not on the network allowlist):
 *
 *   SLACK_BOT_TOKEN=xoxb-... SLACK_APP_TOKEN=xapp-... OPENSHELL_USE_TLS=false \
 *   STATE_STORE_PATH=./state/live-run-state.json node --import tsx scripts/publish-home.ts
 *
 * Target user defaults to the first configured admin; override with HOME_USER=U....
 */
import { WebClient } from "@slack/web-api";
import type { View } from "@slack/types";
import { loadConfig } from "../src/config";
import { StateStore } from "../src/state-store";
import { buildAppHomeView } from "../src/app-home";
import { readAuditSummary } from "../src/audit-summary";
import type { ActionRequest } from "../src/action-request";

function dataVizCount(view: View): number {
  return (view.blocks as Array<{ type?: string }>).filter((b) => b.type === "data_visualization").length;
}

async function main(): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN is not set. Provide it transiently on the command line.");
    process.exit(1);
  }

  const config = loadConfig();
  const store = new StateStore(config.statePath);
  const web = new WebClient(token);

  const auth = await web.auth.test();
  console.log(`auth.test OK: team=${auth.team} (${auth.team_id}) bot=${auth.user} (${auth.user_id})`);

  const userId = process.env.HOME_USER || config.admins[0]?.slack_user_id;
  if (!userId) throw new Error("No target user: set HOME_USER or configure an admin in config/admins.yaml.");

  const records = store.all();
  // The audit-activity summary the capture process writes (if it has run); feeds the audit charts
  // so live-verification exercises them too. Null (no charts) when absent, exactly like the bridge.
  const audit = readAuditSummary(config.capture.summaryStatePath) ?? undefined;
  console.log(
    `Publishing App Home for ${userId} from ${records.length} durable record(s) at ${config.statePath}` +
      `${audit ? ` (+ audit summary at ${config.capture.summaryStatePath})` : " (no audit summary)"}.`,
  );

  // Empty detail cache is correct here: it only feeds pending-card bodies, and a live-verification
  // publish carries only terminal history (charts + KPI + history lines), which need no detail.
  const detail = new Map<string, ActionRequest>();

  // Mirror src/index.ts publishHome(): try richest first, peel down only on rejection. Charts are
  // the least-proven block, so they are dropped first and stay dropped in every deeper tier.
  const tiers: Array<{ opts: { carousel?: boolean; kpiTable?: boolean; charts?: boolean }; label: string }> = [
    { opts: {}, label: "modern (carousel + KPI table + native charts)" },
    { opts: { charts: false }, label: "analytics dropped (charts rejected)" },
    { opts: { charts: false, kpiTable: false }, label: "analytics dropped + KPI strip (table rejected)" },
    { opts: { charts: false, carousel: false }, label: "GA-only fallback (carousel rejected)" },
  ];

  for (let i = 0; i < tiers.length; i++) {
    const view = buildAppHomeView({
      records,
      detail,
      config,
      audit,
      carousel: tiers[i].opts.carousel,
      kpiTable: tiers[i].opts.kpiTable,
      charts: tiers[i].opts.charts,
    });
    const dvz = dataVizCount(view);
    try {
      await web.views.publish({ user_id: userId, view });
      console.log(
        `PUBLISHED via tier ${i} "${tiers[i].label}" ` +
          `(blocks=${view.blocks.length}, data_visualization=${dvz}).`,
      );
      if (i === 0 && dvz > 0) {
        console.log("=> App Home ACCEPTED native data_visualization. The charts render live.");
      } else if (i > 0) {
        console.log(`=> App Home REJECTED the richer tier(s); this workspace fell back to tier ${i}.`);
      }
      return;
    } catch (err) {
      const e = err as { message?: string; data?: { error?: string; response_metadata?: unknown } };
      const detailMsg = e.data?.error ? ` slack_error=${e.data.error}` : "";
      const meta = e.data?.response_metadata ? ` meta=${JSON.stringify(e.data.response_metadata)}` : "";
      console.log(`tier ${i} "${tiers[i].label}" REJECTED (data_visualization=${dvz}): ${e.message ?? err}${detailMsg}${meta}`);
      if (i === tiers.length - 1) {
        console.error("All fallback tiers exhausted; App Home not published.");
        process.exit(1);
      }
    }
  }
}

main().catch((err) => {
  // Print the message only; avoid dumping the error object, which can echo request config/headers.
  console.error("publish-home failed:", (err as Error).message);
  process.exit(1);
});
