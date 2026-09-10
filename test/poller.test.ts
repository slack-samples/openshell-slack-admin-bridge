import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { Poller } from "../src/poller";
import { StateStore } from "../src/state-store";
import type { OpenShellClient, PolicyChunk, NormalizedSandbox } from "../src/openshell-client";

let counter = 0;
function tmpPath(): string {
  counter += 1;
  return join(tmpdir(), `bridge-poller-test-${process.pid}-${counter}.json`);
}

function sandbox(name: string): NormalizedSandbox {
  return { id: `sbx-${name}`, name, workspace: "default", phase: "READY", raw: {} };
}

function chunk(id: string): PolicyChunk {
  return { id, status: "pending", review_token: `rt-${id}` };
}

class FakeClient {
  sandboxes: NormalizedSandbox[] = [sandbox("web")];
  drafts = new Map<string, PolicyChunk[]>([["web", [chunk("c1")]]]);
  failList = false;
  // Sandbox names whose GetDraftPolicy should throw this cycle (per-sandbox failure).
  failDraftFor = new Set<string>();

  listSandboxes = async (): Promise<NormalizedSandbox[]> => {
    if (this.failList) throw new Error("list boom");
    return this.sandboxes;
  };
  getDraftPolicy = async (name: string) => {
    if (this.failDraftFor.has(name)) throw new Error(`draft boom for ${name}`);
    return { chunks: this.drafts.get(name) ?? [] };
  };
}

function makePoller(fake: FakeClient, path: string, concurrency = 1) {
  const store = new StateStore(path);
  const poller = new Poller(fake as unknown as OpenShellClient, store, 999_999, concurrency);
  const newIds: string[] = [];
  const closedIds: string[] = [];
  poller.on("chunk_new", (req) => newIds.push(req.chunkId));
  poller.on("chunk_closed", (id) => closedIds.push(id));
  return { store, poller, newIds, closedIds };
}

test("stops re-emitting chunk_new once the message has been posted", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    const { poller, newIds, store } = makePoller(fake, path);
    await poller.pollOnce();
    assert.deepEqual(newIds, ["c1"]);
    store.setMessageCoords("c1", "C1", "111.1"); // simulate a successful post
    await poller.pollOnce();
    assert.deepEqual(newIds, ["c1"], "no re-emit after the message is posted");
    assert.equal(store.get("c1")?.reviewToken, "rt-c1");
  } finally {
    rmSync(path, { force: true });
  }
});

test("re-emits chunk_new while a discovered chunk still has no posted message", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    const { poller, newIds } = makePoller(fake, path);
    await poller.pollOnce();
    await poller.pollOnce(); // post never landed, so it must be retried
    assert.deepEqual(newIds, ["c1", "c1"]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("does not close a chunk that has a decision in flight (locked)", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    const { poller, closedIds, store } = makePoller(fake, path);
    await poller.pollOnce();
    store.setMessageCoords("c1", "C1", "1.1");
    assert.equal(store.tryLock("c1", "U1"), true);
    fake.drafts.set("web", []); // chunk vanishes mid-approve
    await poller.pollOnce();
    assert.deepEqual(closedIds, [], "locked chunk is not flagged as closed");
  } finally {
    rmSync(path, { force: true });
  }
});

test("detects out-of-band closure of a still-pending chunk", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    const { poller, closedIds } = makePoller(fake, path);
    await poller.pollOnce();
    // The chunk is decided outside the bridge: server stops returning it as pending.
    fake.drafts.set("web", []);
    await poller.pollOnce();
    assert.deepEqual(closedIds, ["c1"]);
  } finally {
    rmSync(path, { force: true });
  }
});

test("does not flag closure when the sandbox was not polled this cycle", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    const { poller, closedIds } = makePoller(fake, path);
    await poller.pollOnce();
    // Sandbox disappears entirely (not polled) -> we cannot conclude it was decided.
    fake.sandboxes = [];
    await poller.pollOnce();
    assert.deepEqual(closedIds, []);
  } finally {
    rmSync(path, { force: true });
  }
});

test("polls multiple sandboxes in parallel and emits every new chunk in sandbox order", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    fake.sandboxes = [sandbox("web"), sandbox("api"), sandbox("worker")];
    fake.drafts = new Map([
      ["web", [chunk("c1")]],
      ["api", [chunk("c2")]],
      ["worker", [chunk("c3")]],
    ]);
    const { poller, newIds, store } = makePoller(fake, path, 8);
    await poller.pollOnce();
    // mapPool preserves input order and results are applied sequentially, so emission
    // order is deterministic regardless of which fetch resolved first.
    assert.deepEqual(newIds, ["c1", "c2", "c3"], "all chunks discovered, order preserved");
    assert.equal(store.get("c2")?.reviewToken, "rt-c2");
    assert.equal(store.allPending().length, 3);
  } finally {
    rmSync(path, { force: true });
  }
});

test("a per-sandbox GetDraftPolicy failure never closes that sandbox's chunk", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    fake.sandboxes = [sandbox("web"), sandbox("api")];
    fake.drafts = new Map([["web", [chunk("c1")]], ["api", [chunk("c2")]]]);
    const { poller, closedIds, store } = makePoller(fake, path, 8);
    await poller.pollOnce();
    store.setMessageCoords("c1", "C1", "1.1");
    store.setMessageCoords("c2", "C2", "2.2");

    // web's read fails (so we cannot conclude c1 was decided), while api genuinely
    // clears c2. Only the successfully-polled sandbox's vanished chunk may close.
    fake.failDraftFor.add("web");
    fake.drafts.set("api", []);
    await poller.pollOnce();
    assert.deepEqual(closedIds, ["c2"], "failed-sandbox chunk left intact; healthy-sandbox closure still detected");
  } finally {
    rmSync(path, { force: true });
  }
});

test("a ListSandboxes failure skips the cycle without emitting", async () => {
  const path = tmpPath();
  try {
    const fake = new FakeClient();
    const { poller, newIds, closedIds } = makePoller(fake, path);
    fake.failList = true;
    let sawError = false;
    poller.on("poll_error", () => (sawError = true));
    await poller.pollOnce();
    assert.equal(sawError, true);
    assert.deepEqual(newIds, []);
    assert.deepEqual(closedIds, []);
  } finally {
    rmSync(path, { force: true });
  }
});
