/**
 * Live Slack smoke test for the OpenShell Admin Bridge.
 *
 * Drives the REAL DecisionService (approve / reject / reconcile / terminal render) against a
 * live in-process mock OpenShell gateway, but with a Slack surface backed by the real
 * @slack/web-api WebClient. Because we do not carry an app-level (xapp-) token, Socket Mode
 * cannot open, so button clicks are simulated by calling svc.approve()/svc.reject() directly.
 *
 * The bot token is read ONLY from the SLACK_BOT_TOKEN environment variable and is never
 * written to disk or logged. Run with the sandbox disabled (api.slack.com is not on the
 * network allowlist).
 *
 *   SLACK_BOT_TOKEN=xoxb-... node --import tsx scripts/live-smoke.ts auth    # read-only: auth.test
 *   SLACK_BOT_TOKEN=xoxb-... node --import tsx scripts/live-smoke.ts smoke   # posts to a DM, then decides
 *
 * Target DM is set via SMOKE_ADMIN_USER (a Slack user ID); required for the smoke test.
 */
import { WebClient } from "@slack/web-api";
import type { KnownBlock } from "@slack/types";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { startMockServer, resetMockState } from "../src/mock-server";
import { OpenShellClient } from "../src/openshell-client";
import { StateStore } from "../src/state-store";
import { DecisionService, type SlackSurface, type PostMessageResult } from "../src/decision-service";
import type { AppConfig, OpenShellAuth } from "../src/config";

const ADMIN_USER: string = process.env.SMOKE_ADMIN_USER ?? "";
if (!ADMIN_USER) {
  throw new Error("SMOKE_ADMIN_USER must be set to the Slack user ID to DM for the smoke test.");
}
const insecureAuth: OpenShellAuth = { mode: "mtls", useTls: false };

// Backs the decision logic with the real Slack Web API. Mirrors production's boltSurface:
// chat:write only, no self-join (the target channel must already have the bot in it).
function webClientSurface(web: WebClient): SlackSurface {
  return {
    async postMessage({ channel, text, blocks }): Promise<PostMessageResult> {
      const res = await web.chat.postMessage({ channel, text, blocks: blocks as KnownBlock[], unfurl_links: false });
      return { ts: res.ts, channel: (res.channel as string | undefined) ?? channel };
    },
    async updateMessage({ channel, ts, text, blocks }): Promise<void> {
      // Slack echoes back the stored message; log its fallback text as authoritative proof
      // the terminal card rendered (we lack channels:history to read it back separately).
      const res = await web.chat.update({ channel, ts, text, blocks: blocks as KnownBlock[] });
      console.log(`  update echo @${res.ts}: ${(res as { text?: string }).text ?? "(no text)"}`);
    },
  };
}

function makeConfig(dmChannel: string, statePath: string): AppConfig {
  return {
    slack: { botToken: "unused-here", appToken: "unused-here" },
    openshell: { gatewayUrl: "in-process", auth: insecureAuth },
    admins: [{ slack_user_id: ADMIN_USER, name: "Smoke Admin", role: "super_admin" }],
    routing: { defaultChannel: dmChannel, workspaceChannels: {} },
    settings: { rejectReasonRequired: true, destructiveRoles: ["super_admin"] },
    defaultWorkspace: "default",
    pollIntervalMs: 999_999,
    pollConcurrency: 25,
    watchMode: "off",
    capture: { sources: [], excludeEventTypes: [], summaryStatePath: "./state/audit-summary.json" },
    statePath,
    logLevel: "info",
  };
}

function requireToken(): string {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error("SLACK_BOT_TOKEN is not set. Provide it transiently on the command line.");
    process.exit(1);
  }
  return token;
}

async function runAuth(web: WebClient): Promise<void> {
  const auth = await web.auth.test();
  console.log("auth.test OK:");
  console.log(`  team:    ${auth.team} (${auth.team_id})`);
  console.log(`  bot:     ${auth.user} (${auth.user_id})`);
  console.log(`  url:     ${auth.url}`);

  // Read-only check: does the intended DM target resolve in THIS workspace?
  try {
    const info = await web.users.info({ user: ADMIN_USER });
    const u = info.user;
    console.log(`target ${ADMIN_USER} resolves: ${u?.real_name || u?.name} (bot=${!!u?.is_bot})`);
  } catch (err) {
    console.log(`target ${ADMIN_USER} does NOT resolve here: ${(err as Error).message}`);
  }
}

// Where the smoke cards land: an explicit channel (SMOKE_CHANNEL, matching production's
// channel routing) if set, otherwise a DM to the target admin.
async function resolveDestination(web: WebClient): Promise<string> {
  const channel = process.env.SMOKE_CHANNEL;
  if (channel) {
    console.log(`Posting to channel: ${channel} (bot must already be a member)`);
    return channel;
  }
  const dm = await web.conversations.open({ users: ADMIN_USER });
  const dmChannel = dm.channel?.id;
  if (!dmChannel) throw new Error("Could not open a DM channel with the target user.");
  console.log(`DM channel with ${ADMIN_USER}: ${dmChannel}`);
  return dmChannel;
}

async function runSmoke(web: WebClient): Promise<void> {
  const dmChannel = await resolveDestination(web);

  resetMockState();
  const handle = await startMockServer("127.0.0.1:0");
  const client = new OpenShellClient(`127.0.0.1:${handle.port}`, insecureAuth, "default");
  const statePath = join(tmpdir(), `bridge-smoke-${process.pid}.json`);
  const store = new StateStore(statePath);
  const svc = new DecisionService(makeConfig(dmChannel, statePath), client, store, webClientSurface(web));

  try {
    // 1) Reconcile posts every pending proposal as a real approval card in the DM.
    await svc.reconcile();
    const pending = store.allPending();
    console.log(`Posted ${pending.length} approval card(s) to ${dmChannel}.`);
    for (const rec of pending) console.log(`  chunk ${rec.chunkId} -> ts ${rec.messageTs}`);

    const [toApprove, toReject] = pending.map((r) => r.chunkId);

    // 2) Simulate an admin clicking Approve on the first card.
    if (toApprove) {
      const res = await svc.approve(ADMIN_USER, toApprove);
      console.log(`approve(${toApprove}):`, JSON.stringify(res));
    }

    // 3) Simulate an admin rejecting the second card with a reason.
    if (toReject) {
      const res = await svc.reject(ADMIN_USER, toReject, "Smoke test: destination not on the allowlist.");
      console.log(`reject(${toReject}):`, JSON.stringify(res));
    }

    // Verify the posted messages now render terminal state. Needs history scope; if the bot
    // lacks it, fall back to the no-error evidence above.
    await verifyTerminal(web, dmChannel, [
      { chunkId: toApprove, ts: store.get(toApprove)?.messageTs, expect: "Approved" },
      { chunkId: toReject, ts: store.get(toReject)?.messageTs, expect: "Rejected" },
    ]);

    console.log("Smoke flow complete. Both cards should now show terminal (Approved / Rejected) state.");
  } finally {
    client.close();
    handle.close();
    rmSync(statePath, { force: true });
  }
}

// Read each posted message back and confirm its text now carries the terminal marker.
async function verifyTerminal(
  web: WebClient,
  channel: string,
  items: { chunkId?: string; ts?: string; expect: string }[],
): Promise<void> {
  for (const it of items) {
    if (!it.chunkId || !it.ts) continue;
    try {
      const hist = await web.conversations.history({ channel, latest: it.ts, oldest: it.ts, inclusive: true, limit: 1 });
      const msg = hist.messages?.[0];
      const text = msg?.text ?? "";
      const blocks = JSON.stringify(msg?.blocks ?? []);
      const ok = text.includes(it.expect) || blocks.includes(it.expect);
      console.log(`verify ${it.chunkId}: ${ok ? "OK" : "MISSING"} (expected "${it.expect}" in rendered card)`);
    } catch (err) {
      console.log(`verify ${it.chunkId}: could not read back (${(err as Error).message}); relying on no-error update evidence.`);
    }
  }
}

// Delete smoke artifacts. SMOKE_DELETE_TS is a comma-separated list of message ts in
// SMOKE_CHANNEL (only the bot's own messages can be removed with chat:write).
async function runCleanup(web: WebClient): Promise<void> {
  const channel = process.env.SMOKE_CHANNEL;
  const list = (process.env.SMOKE_DELETE_TS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!channel || list.length === 0) {
    console.error("cleanup needs SMOKE_CHANNEL and SMOKE_DELETE_TS (comma-separated ts).");
    process.exit(1);
  }
  for (const ts of list) {
    try {
      await web.chat.delete({ channel, ts });
      console.log(`deleted ${ts}`);
    } catch (err) {
      console.log(`could not delete ${ts}: ${(err as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] || "auth";
  const web = new WebClient(requireToken());
  await runAuth(web);
  if (mode === "smoke") {
    await runSmoke(web);
  } else if (mode === "cleanup") {
    await runCleanup(web);
  } else if (mode !== "auth") {
    console.error(`Unknown mode "${mode}". Use "auth", "smoke", or "cleanup".`);
    process.exit(1);
  }
}

main().catch((err) => {
  // Avoid dumping the whole error object (which can echo request config); print the message.
  console.error("Smoke test failed:", (err as Error).message);
  process.exit(1);
});
