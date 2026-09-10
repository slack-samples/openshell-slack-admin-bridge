import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, rmSync, readFileSync } from "node:fs";
import { StateStore } from "../src/state-store";

let counter = 0;
function tmpPath(): string {
  counter += 1;
  return join(tmpdir(), `bridge-state-test-${process.pid}-${counter}.json`);
}

test("discovers a chunk, persists it, and reloads it", () => {
  const path = tmpPath();
  try {
    const store = new StateStore(path);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default", reviewToken: "rt-1" });
    assert.equal(store.get("c1")?.status, "pending");
    assert.ok(existsSync(path));

    const reloaded = new StateStore(path);
    assert.equal(reloaded.get("c1")?.reviewToken, "rt-1");
    assert.equal(reloaded.allPending().length, 1);
  } finally {
    rmSync(path, { force: true });
  }
});

test("refreshes review_token without duplicating and never downgrades terminal", () => {
  const path = tmpPath();
  try {
    const store = new StateStore(path);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default", reviewToken: "rt-1" });
    store.markTerminal("c1", "approved", { decidedBy: "U1", policyVersion: 5 });
    assert.equal(store.isTerminal("c1"), true);

    // A later poll re-discovering the same id must not resurrect it to pending.
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default", reviewToken: "rt-2" });
    assert.equal(store.get("c1")?.status, "approved");
    assert.equal(store.get("c1")?.reviewToken, "rt-2");
    assert.equal(store.allPending().length, 0);
  } finally {
    rmSync(path, { force: true });
  }
});

test("setMessageCoords updates coords without clobbering an already-captured permalink", () => {
  const path = tmpPath();
  try {
    const store = new StateStore(path);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default" });

    // First post resolves a permalink.
    store.setMessageCoords("c1", "C_A", "1700000000.000001", "https://acme.slack.com/archives/C_A/p1700000000000001");
    assert.equal(store.get("c1")?.permalink, "https://acme.slack.com/archives/C_A/p1700000000000001");

    // A later coords write with no permalink (e.g. a failed getPermalink, or a pre-permalink
    // caller) must refresh channel/ts but leave the captured link intact.
    store.setMessageCoords("c1", "C_B", "1700000000.000002");
    assert.equal(store.get("c1")?.channelId, "C_B");
    assert.equal(store.get("c1")?.messageTs, "1700000000.000002");
    assert.equal(store.get("c1")?.permalink, "https://acme.slack.com/archives/C_A/p1700000000000001", "permalink survives an undefined-permalink write");
  } finally {
    rmSync(path, { force: true });
  }
});

test("tryLock enforces single in-flight decision and respects TTL", () => {
  const path = tmpPath();
  try {
    let now = 1_000_000;
    const store = new StateStore(path, () => now);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default" });

    assert.equal(store.tryLock("c1", "U1"), true);
    assert.equal(store.tryLock("c1", "U2"), false, "second concurrent lock is rejected");

    // Advance past the lock TTL: the stale lock becomes reclaimable.
    now += 61_000;
    assert.equal(store.tryLock("c1", "U2"), true, "stale lock reclaimed after TTL");

    store.markTerminal("c1", "rejected", { decidedBy: "U2", rejectReason: "nope" });
    assert.equal(store.tryLock("c1", "U3"), false, "cannot lock a terminal record");
  } finally {
    rmSync(path, { force: true });
  }
});

test("isLocked reflects a held, non-stale lock and clears on terminal", () => {
  const path = tmpPath();
  try {
    let now = 1_000_000;
    const store = new StateStore(path, () => now);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default" });
    assert.equal(store.isLocked("c1"), false);
    store.tryLock("c1", "U1");
    assert.equal(store.isLocked("c1"), true);
    now += 61_000; // lock goes stale
    assert.equal(store.isLocked("c1"), false);
  } finally {
    rmSync(path, { force: true });
  }
});

test("first terminal write wins: a later 'closed' cannot clobber an approval", () => {
  const path = tmpPath();
  try {
    const store = new StateStore(path);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s1", sandboxName: "web", workspace: "default" });
    store.markTerminal("c1", "approved", { decidedBy: "U1", policyVersion: 3 });
    store.markTerminal("c1", "closed"); // out-of-band closure arriving late
    assert.equal(store.get("c1")?.status, "approved");
    assert.equal(store.get("c1")?.policyVersion, 3);
  } finally {
    rmSync(path, { force: true });
  }
});

test("pruneTerminal removes only terminal records older than the cutoff, keeps pending", () => {
  const path = tmpPath();
  try {
    let now = 1_000_000;
    const store = new StateStore(path, () => now);

    // c1: approved long ago (decidedAt = 1_000_000).
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s", sandboxName: "web", workspace: "default" });
    store.markTerminal("c1", "approved", { decidedBy: "U1" });
    // c2: still pending -> must never be pruned regardless of age.
    store.upsertDiscovered({ chunkId: "c2", sandboxId: "s", sandboxName: "web", workspace: "default" });
    // c3: closed recently (decidedAt = 1_050_000).
    now = 1_050_000;
    store.upsertDiscovered({ chunkId: "c3", sandboxId: "s", sandboxName: "web", workspace: "default" });
    store.markTerminal("c3", "closed");

    now = 1_060_000;
    const removed = store.pruneTerminal(20_000); // cutoff = 1_040_000
    assert.equal(removed, 1, "only c1 (decided at 1_000_000) predates the cutoff");
    assert.equal(store.get("c1"), undefined);
    assert.equal(store.get("c2")?.status, "pending", "pending records are never pruned");
    assert.equal(store.get("c3")?.status, "closed", "recent terminal records survive");

    // The prune persisted: a reload from disk agrees.
    const reloaded = new StateStore(path, () => now);
    assert.equal(reloaded.get("c1"), undefined);
    assert.equal(reloaded.allPending().length, 1);
  } finally {
    rmSync(path, { force: true });
  }
});

test("pruneTerminal is a no-op when nothing is old enough", () => {
  const path = tmpPath();
  try {
    let now = 1_000_000;
    const store = new StateStore(path, () => now);
    store.upsertDiscovered({ chunkId: "c1", sandboxId: "s", sandboxName: "web", workspace: "default" });
    store.markTerminal("c1", "approved", { decidedBy: "U1" });
    now = 1_000_500;
    assert.equal(store.pruneTerminal(10_000), 0);
    assert.equal(store.get("c1")?.status, "approved");
  } finally {
    rmSync(path, { force: true });
  }
});

test("a zero-length state file loads as fresh rather than throwing", () => {
  const path = tmpPath();
  try {
    require("node:fs").writeFileSync(path, "", "utf8");
    const store = new StateStore(path);
    assert.equal(store.allPending().length, 0);
  } finally {
    rmSync(path, { force: true });
  }
});

test("does not overwrite an unreadable state file", () => {
  const path = tmpPath();
  try {
    require("node:fs").writeFileSync(path, "{ this is not json", "utf8");
    assert.throws(() => new StateStore(path));
    // The corrupt file is left intact for an operator to inspect.
    assert.equal(readFileSync(path, "utf8").startsWith("{ this is not json"), true);
  } finally {
    rmSync(path, { force: true });
  }
});
