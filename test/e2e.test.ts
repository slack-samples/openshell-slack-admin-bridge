import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { KnownBlock } from "@slack/types";
import {
  startMockServer,
  resetMockState,
  rotateReviewToken,
  forceCloseChunk,
  injectLateProposal,
  type MockServerHandle,
} from "../src/mock-server";
import { OpenShellClient } from "../src/openshell-client";
import { StateStore } from "../src/state-store";
import { Poller } from "../src/poller";
import { DecisionService, type SlackSurface, type PostMessageResult } from "../src/decision-service";
import { REJECT_REASON_BLOCK } from "../src/slack-messages";
import type { AppConfig, OpenShellAuth } from "../src/config";

// True end-to-end: the real decision service + poller + gRPC client run against the live
// mock OpenShell gateway. Slack is stood in by a fake surface that records what would have
// been posted/updated, so the actual approve/reject/reconcile/closure logic is exercised
// without a live Socket Mode connection (which needs an app-level token we do not carry).

const ADMIN = "U_ADMIN";
const SANDBOX = "web-agent";
const insecureAuth: OpenShellAuth = { mode: "mtls", useTls: false };

let handle: MockServerHandle;
let client: OpenShellClient;
const tmpPaths: string[] = [];

let seq = 0;
function tmpPath(): string {
  seq += 1;
  const p = join(tmpdir(), `bridge-e2e-${process.pid}-${seq}.json`);
  tmpPaths.push(p);
  return p;
}

class FakeSlackSurface implements SlackSurface {
  posts: { channel: string; text: string; blocks: KnownBlock[]; ts: string }[] = [];
  updates: { channel: string; ts: string; text: string; blocks: KnownBlock[] }[] = [];
  permalinkCalls: { channel: string; messageTs: string }[] = [];
  // Number of upcoming postMessage calls that should throw, and the error they throw.
  failNextPost = 0;
  failNextPostError: unknown = new Error("slack unavailable");
  // When true, getPermalink throws, to exercise the best-effort permalink fallback.
  failPermalink = false;
  private tsSeq = 0;

  async postMessage(args: { channel: string; text: string; blocks: KnownBlock[] }): Promise<PostMessageResult> {
    if (this.failNextPost > 0) {
      this.failNextPost -= 1;
      throw this.failNextPostError;
    }
    this.tsSeq += 1;
    const ts = `1700000000.${String(this.tsSeq).padStart(6, "0")}`;
    this.posts.push({ ...args, ts });
    return { ts, channel: args.channel };
  }

  async updateMessage(args: { channel: string; ts: string; text: string; blocks: KnownBlock[] }): Promise<void> {
    this.updates.push(args);
  }

  async getPermalink(args: { channel: string; messageTs: string }): Promise<string | undefined> {
    this.permalinkCalls.push(args);
    if (this.failPermalink) throw new Error("permalink boom");
    return `https://acme.slack.com/archives/${args.channel}/p${args.messageTs.replace(".", "")}`;
  }
}

function makeConfig(overrides: { rejectReasonRequired?: boolean } = {}): AppConfig {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    openshell: { gatewayUrl: "unused", auth: insecureAuth },
    admins: [{ slack_user_id: ADMIN, name: "Ada Admin", role: "super_admin" }],
    routing: { defaultChannel: "C_TEST", workspaceChannels: {} },
    settings: {
      rejectReasonRequired: overrides.rejectReasonRequired ?? true,
      destructiveRoles: ["super_admin"],
    },
    defaultWorkspace: "default",
    pollIntervalMs: 999_999,
    pollConcurrency: 25,
    watchMode: "off",
    capture: { sources: [], excludeEventTypes: [], summaryStatePath: "./state/audit-summary.json" },
    statePath: "unused",
    logLevel: "silent",
  };
}

// Build a full runtime harness sharing the live mock client. The poller feeds the real
// service handlers; drainPoll runs one poll cycle and awaits any in-flight posting.
function harness(cfg: AppConfig = makeConfig()) {
  const store = new StateStore(tmpPath());
  const surface = new FakeSlackSurface();
  const svc = new DecisionService(cfg, client, store, surface);
  const poller = new Poller(client, store, 999_999);
  const inflight: Promise<void>[] = [];
  poller.on("chunk_new", (req) => inflight.push(svc.handleChunkNew(req)));
  poller.on("chunk_closed", (id) => inflight.push(svc.handleChunkClosed(id)));
  const drainPoll = async () => {
    await poller.pollOnce();
    await Promise.all(inflight.splice(0));
  };
  return { store, surface, svc, poller, drainPoll };
}

async function pendingIds(): Promise<string[]> {
  const resp = await client.getDraftPolicy(SANDBOX, "default", "pending");
  return (resp.chunks ?? []).map((c) => c.id);
}

before(async () => {
  handle = await startMockServer("127.0.0.1:0");
  client = new OpenShellClient(`127.0.0.1:${handle.port}`, insecureAuth, "default");
});

after(() => {
  client.close();
  handle.close();
  for (const p of tmpPaths) rmSync(p, { force: true });
});

beforeEach(() => {
  resetMockState();
});

test("reconcile posts each pending proposal to its routed channel", async () => {
  const h = harness();
  await h.svc.reconcile();
  assert.equal(h.surface.posts.length, 2);
  for (const p of h.surface.posts) assert.equal(p.channel, "C_TEST");
  assert.equal(h.store.allPending().length, 2);
});

test("a posted approval captures its message permalink for the App Home deep-link", async () => {
  const h = harness();
  await h.svc.reconcile();
  assert.ok(h.surface.permalinkCalls.length >= 1, "getPermalink is called after posting");
  const pending = h.store.allPending();
  assert.equal(pending.length, 2);
  for (const rec of pending) {
    assert.match(rec.permalink ?? "", /^https:\/\/acme\.slack\.com\/archives\/C_TEST\/p1700000000/);
  }
});

test("a failing permalink lookup does not break posting (best-effort)", async () => {
  const h = harness();
  h.surface.failPermalink = true;
  await h.svc.reconcile();
  // Posts still land and coordinates are stored; only the cosmetic permalink is absent.
  assert.equal(h.surface.posts.length, 2);
  for (const rec of h.store.allPending()) {
    assert.ok(rec.messageTs, "message coordinates are still persisted");
    assert.equal(rec.permalink, undefined);
  }
});

test("reconcile backfills a permalink for an already-posted card without reposting", async () => {
  const store = new StateStore(tmpPath());
  const surface = new FakeSlackSurface();
  const svc = new DecisionService(makeConfig(), client, store, surface);
  // Derive a real pending id from the mock rather than hardcoding one, so this does not silently
  // depend on the mock's seed naming (reconcile only backfills chunks the gateway returns).
  const [chunkId] = await pendingIds();
  assert.ok(chunkId, "mock returns at least one pending chunk");
  // Simulate a card posted before the permalink feature: coordinates present, no permalink.
  store.upsertDiscovered({ chunkId, sandboxId: "sbx-001", sandboxName: SANDBOX, workspace: "default" });
  store.setMessageCoords(chunkId, "C_TEST", "1699999999.000001");
  assert.equal(store.get(chunkId)!.permalink, undefined);

  await svc.reconcile();

  // The chunk keeps its original coordinates (not reposted) but now carries a backfilled permalink.
  assert.equal(store.get(chunkId)!.messageTs, "1699999999.000001");
  assert.match(store.get(chunkId)!.permalink ?? "", /archives\/C_TEST\/p1699999999000001/);
});

test("the poller discovers and posts a late-arriving proposal", async () => {
  const h = harness();
  await h.svc.reconcile(); // seeds posted, coords recorded
  const lateId = injectLateProposal();
  await h.drainPoll();
  assert.ok(h.store.get(lateId), "late chunk is now tracked");
  assert.equal(h.surface.posts.length, 3, "only the late chunk is newly posted");
  assert.ok(
    h.surface.posts.some((p) => JSON.stringify(p.blocks).includes(lateId)),
    "the late chunk was the one posted",
  );
});

test("approve merges the policy, bumps the version, and renders a terminal card", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [target] = await pendingIds();

  const res = await h.svc.approve(ADMIN, target);
  assert.ok(res.ok);
  assert.equal(res.status, "approved");
  assert.ok((res.policyVersion ?? 0) >= 2);

  assert.equal((await pendingIds()).includes(target), false, "no longer pending on the server");
  assert.equal(h.store.get(target)?.status, "approved");
  assert.equal(h.store.get(target)?.decidedBy, ADMIN);
  assert.ok(
    h.surface.updates.some((u) => JSON.stringify(u.blocks).includes("Approved")),
    "the original message was updated in place",
  );
});

test("approve refreshes a stale review_token and retries once", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [target] = await pendingIds();
  const captured = h.store.get(target)?.reviewToken;

  const rotated = rotateReviewToken(SANDBOX, target); // the bridge's token is now stale
  assert.notEqual(rotated, captured);

  const res = await h.svc.approve(ADMIN, target);
  assert.ok(res.ok);
  assert.equal(res.status, "approved");
  assert.equal(h.store.get(target)?.status, "approved");
  assert.equal(h.store.get(target)?.reviewToken, rotated, "store captured the refreshed token");
});

test("reject records the reason, removes the chunk, and renders a terminal card", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [target] = await pendingIds();

  const res = await h.svc.reject(ADMIN, target, "destination is not on the allowlist");
  assert.ok(res.ok);
  assert.equal(res.status, "rejected");

  assert.equal((await pendingIds()).includes(target), false);
  assert.equal(h.store.get(target)?.status, "rejected");
  assert.equal(h.store.get(target)?.rejectReason, "destination is not on the allowlist");
  assert.ok(h.surface.updates.some((u) => JSON.stringify(u.blocks).includes("Rejected")));
});

test("reject is blocked when a reason is required but missing", async () => {
  const h = harness(makeConfig({ rejectReasonRequired: true }));
  await h.svc.reconcile();
  const [target] = await pendingIds();

  const res = await h.svc.reject(ADMIN, target, "   ");
  assert.ok(!res.ok);
  assert.equal(res.code, "reason_required");

  assert.equal(h.store.get(target)?.status, "pending", "nothing decided");
  assert.equal((await pendingIds()).includes(target), true, "still pending on the server");
  assert.deepEqual(h.svc.validateRejectSubmission(ADMIN, ""), {
    block: REJECT_REASON_BLOCK,
    error: "A reason is required.",
  });
});

test("validateRejectSubmission accepts an admin+reason, and an empty reason when optional", () => {
  const required = new DecisionService(makeConfig({ rejectReasonRequired: true }), client, new StateStore(tmpPath()), new FakeSlackSurface());
  assert.equal(required.validateRejectSubmission(ADMIN, "because"), null);
  const optional = new DecisionService(makeConfig({ rejectReasonRequired: false }), client, new StateStore(tmpPath()), new FakeSlackSurface());
  assert.equal(optional.validateRejectSubmission(ADMIN, ""), null);
});

test("a non-admin cannot approve, reject, or open the reject modal", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [target] = await pendingIds();

  const a = await h.svc.approve("U_STRANGER", target);
  assert.ok(!a.ok);
  assert.equal(a.code, "not_admin");

  const r = await h.svc.reject("U_STRANGER", target, "no reason given");
  assert.ok(!r.ok);
  assert.equal(r.code, "not_admin");

  const m = h.svc.rejectModalFor("U_STRANGER", target);
  assert.ok(!m.ok);
  assert.equal(m.code, "not_admin");

  assert.equal(h.store.get(target)?.status, "pending", "no state change from an unauthorized user");
  assert.equal((await pendingIds()).includes(target), true);
});

test("two concurrent approvals: exactly one wins, the other is told it is in flight", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [target] = await pendingIds();

  const [r1, r2] = await Promise.all([h.svc.approve(ADMIN, target), h.svc.approve(ADMIN, target)]);
  const wins = [r1, r2].filter((r) => r.ok);
  const blocked = [r1, r2].filter((r) => !r.ok && r.code === "in_flight");
  assert.equal(wins.length, 1, "single-writer wins");
  assert.equal(blocked.length, 1, "the other is rejected as in flight");
  assert.equal(h.store.get(target)?.status, "approved");
});

test("out-of-band closure is detected and renders a closed card", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [target] = await pendingIds();

  forceCloseChunk(SANDBOX, target); // decided outside the bridge
  await h.drainPoll();

  assert.equal(h.store.get(target)?.status, "closed");
  assert.ok(h.surface.updates.some((u) => JSON.stringify(u.blocks).includes("Closed")));
});

test("closure is ignored for a chunk in flight or already terminal", async () => {
  const h = harness();
  await h.svc.reconcile();
  const [locked, decided] = await pendingIds();

  assert.equal(h.store.tryLock(locked, ADMIN), true); // a decision RPC is in flight
  const approved = await h.svc.approve(ADMIN, decided); // already terminal
  assert.ok(approved.ok);

  const updatesBefore = h.surface.updates.length;
  await h.svc.handleChunkClosed(locked);
  await h.svc.handleChunkClosed(decided);

  assert.notEqual(h.store.get(locked)?.status, "closed", "locked chunk is not clobbered");
  assert.equal(h.store.get(decided)?.status, "approved", "approval survives a late closure");
  assert.equal(h.surface.updates.length, updatesBefore, "ignored closures render nothing");
});

test("reconcile after restart does not repost posted chunks, but reposts unposted ones", async () => {
  const cfg = makeConfig();
  const statePath = tmpPath();

  const svc1 = new DecisionService(cfg, client, new StateStore(statePath), new FakeSlackSurface());
  await svc1.reconcile();

  // Restart: reload the same durable state.
  const store2 = new StateStore(statePath);
  const surface2 = new FakeSlackSurface();
  const svc2 = new DecisionService(cfg, client, store2, surface2);
  await svc2.reconcile();
  assert.equal(surface2.posts.length, 0, "both chunks already have message coords");
  assert.equal(store2.allPending().length, 2);

  // A newly discovered chunk with no message is reposted on the next reconcile.
  const lateId = injectLateProposal();
  await svc2.reconcile();
  assert.equal(surface2.posts.length, 1);
  assert.ok(JSON.stringify(surface2.posts[0].blocks).includes(lateId));
});

test("a transient post failure is retried on the next poll without duplicating", async () => {
  const h = harness();
  h.surface.failNextPost = 1; // the first postMessage this cycle throws

  await h.drainPoll(); // one chunk fails to post, the other succeeds
  assert.equal(h.surface.posts.length, 1, "only the successful post landed");
  assert.equal(h.store.allPending().filter((r) => !r.messageTs).length, 1, "one chunk still has no message");

  await h.drainPoll(); // the unposted chunk is re-emitted and retried
  assert.equal(h.surface.posts.length, 2, "failed chunk retried; posted chunk not duplicated");
  assert.equal(h.store.allPending().filter((r) => !r.messageTs).length, 0);
});
