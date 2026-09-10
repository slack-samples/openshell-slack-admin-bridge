import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditSummaryStore,
  readAuditSummary,
  UNKNOWN_SANDBOX,
  UNKNOWN_SEVERITY,
} from "../src/audit-summary";
import type { NormalizedAuditEvent } from "../src/capture/normalize";

// A minimal normalized event; every test overrides only the fields it exercises. timeMs defaults
// to a fixed in-2025 instant so the day key is deterministic.
function ev(over: Partial<NormalizedAuditEvent> = {}): NormalizedAuditEvent {
  return {
    classUid: 1007,
    className: "Process Activity",
    activityName: "Launch",
    typeName: "Process Activity: Launch",
    typeUid: null,
    timeMs: Date.UTC(2025, 0, 2, 12, 0, 0), // 2025-01-02
    severityId: 1,
    severity: "Informational",
    statusId: null,
    status: null,
    message: null,
    statusDetail: null,
    sandboxUid: "sbx-1",
    productName: null,
    container: null,
    deviceHostname: null,
    extra: {},
    ...over,
  };
}

function withDir<T>(run: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "audit-sum-"));
  try {
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Async variant: awaits `run` before removing the dir, so timer-driven tests don't have their
// files deleted out from under a pending flush.
async function withDirAsync<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "audit-sum-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// "now" pinned near the events' own day (2025-01-02) so the default 30-day retention window keeps
// them; without this, a real-clock now would prune these fixed-date test events on flush.
const NOW = Date.UTC(2025, 0, 2, 15, 0, 0);

test("record accumulates per-day, per-sandbox and per-severity counts and flushes atomically", () => {
  withDir((dir) => {
    const path = join(dir, "audit-summary.json");
    const store = new AuditSummaryStore(path, { flushIntervalMs: 10_000, nowFn: () => NOW });
    store.record(ev({ sandboxUid: "sbx-1", severityId: 1 }));
    store.record(ev({ sandboxUid: "sbx-1", severityId: 3 }));
    store.record(ev({ sandboxUid: "sbx-2", severityId: 1 }));
    store.flush();

    assert.ok(existsSync(path));
    const data = readAuditSummary(path)!;
    assert.equal(data.version, 1);
    const day = data.days["2025-01-02"];
    assert.equal(day.total, 3);
    assert.deepEqual(day.bySandbox, { "sbx-1": 2, "sbx-2": 1 });
    assert.deepEqual(day.bySeverity, { "1": 2, "3": 1 });
    store.stop();
  });
});

test("null sandbox/severity fall into the unknown buckets; null time uses the ingest day", () => {
  withDir((dir) => {
    const path = join(dir, "s.json");
    const store = new AuditSummaryStore(path, {
      flushIntervalMs: 10_000,
      nowFn: () => Date.UTC(2025, 5, 15, 0, 0, 0), // 2025-06-15
    });
    store.record(ev({ sandboxUid: null, severityId: null, timeMs: null }));
    store.flush();

    const day = readAuditSummary(path)!.days["2025-06-15"]; // bucketed by ingest day (nowFn)
    assert.equal(day.total, 1);
    assert.equal(day.bySandbox[UNKNOWN_SANDBOX], 1);
    assert.equal(day.bySeverity[UNKNOWN_SEVERITY], 1);
    store.stop();
  });
});

test("counts accumulate across restarts (a new store reloads the existing file)", () => {
  withDir((dir) => {
    const path = join(dir, "s.json");
    const a = new AuditSummaryStore(path, { flushIntervalMs: 10_000, nowFn: () => NOW });
    a.record(ev({ sandboxUid: "sbx-1" }));
    a.flush();
    a.stop();

    const b = new AuditSummaryStore(path, { flushIntervalMs: 10_000, nowFn: () => NOW });
    b.record(ev({ sandboxUid: "sbx-1" }));
    b.flush();
    b.stop();

    assert.equal(readAuditSummary(path)!.days["2025-01-02"].bySandbox["sbx-1"], 2);
  });
});

test("flush prunes days older than the retention window", () => {
  withDir((dir) => {
    const path = join(dir, "s.json");
    const now = Date.UTC(2025, 1, 1, 0, 0, 0); // 2025-02-01; cutoff = 2025-01-27 for a 5-day window
    const store = new AuditSummaryStore(path, { flushIntervalMs: 10_000, retentionDays: 5, nowFn: () => now });
    store.record(ev({ timeMs: Date.UTC(2025, 0, 1) })); // 2025-01-01: 31 days old -> pruned
    store.record(ev({ timeMs: Date.UTC(2025, 0, 30) })); // 2025-01-30: within window -> kept
    store.flush();

    const data = readAuditSummary(path)!;
    assert.equal(data.days["2025-01-01"], undefined, "out-of-retention day pruned");
    assert.ok(data.days["2025-01-30"], "in-retention day kept");
    store.stop();
  });
});

test("readAuditSummary returns null for a missing, empty or corrupt file", () => {
  withDir((dir) => {
    assert.equal(readAuditSummary(join(dir, "nope.json")), null, "missing");

    const empty = join(dir, "empty.json");
    writeFileSync(empty, "   \n", "utf8");
    assert.equal(readAuditSummary(empty), null, "whitespace-only");

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not valid json", "utf8");
    assert.equal(readAuditSummary(bad), null, "corrupt");

    const wrongShape = join(dir, "wrong.json");
    writeFileSync(wrongShape, JSON.stringify({ version: 1, updatedAt: 0 }), "utf8"); // no `days`
    assert.equal(readAuditSummary(wrongShape), null, "missing days map");
  });
});

test("stop() flushes counts buffered since the last coalesced write", () => {
  withDir((dir) => {
    const path = join(dir, "s.json");
    const store = new AuditSummaryStore(path, { flushIntervalMs: 10_000, nowFn: () => NOW });
    store.record(ev({ sandboxUid: "sbx-1" }));
    // The coalescing timer has not fired, so nothing is on disk yet.
    assert.equal(readAuditSummary(path), null, "not flushed before the interval elapses");
    store.stop();
    const data = readAuditSummary(path)!;
    assert.equal(data.days["2025-01-02"].bySandbox["sbx-1"], 1, "stop() forced a final write");
  });
});

test("a scheduled (coalesced) flush persists without an explicit flush(), and coalesces a burst", async () => {
  await withDirAsync(async (dir) => {
    const path = join(dir, "s.json");
    const store = new AuditSummaryStore(path, { flushIntervalMs: 10, nowFn: () => NOW });
    store.record(ev({ sandboxUid: "sbx-1" }));
    store.record(ev({ sandboxUid: "sbx-1" })); // second record while the timer is pending -> coalesced
    assert.equal(readAuditSummary(path), null, "write is deferred to the timer, so nothing on disk yet");
    await delay(80); // let the single coalesced timer fire (no explicit flush()/stop())
    const data = readAuditSummary(path);
    assert.ok(data, "the scheduled flush wrote the file on its own");
    assert.equal(data!.days["2025-01-02"].bySandbox["sbx-1"], 2, "both buffered records landed in one write");
    store.stop();
  });
});

test("a persist failure never throws: the audit summary is best-effort and must not crash capture", () => {
  withDir((dir) => {
    // Point the summary under a path whose parent is a FILE, so persist()'s mkdir/open throws.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x", "utf8");
    const path = join(blocker, "nested", "audit-summary.json");
    const store = new AuditSummaryStore(path, { flushIntervalMs: 10_000, nowFn: () => NOW });
    store.record(ev({ sandboxUid: "sbx-1" }));
    // A throw here would escape the coalescing timer and take down the capture process.
    assert.doesNotThrow(() => store.flush(), "flush swallows the persist error");
    assert.equal(readAuditSummary(path), null, "nothing was written");
    assert.doesNotThrow(() => store.stop(), "stop()'s final flush is safe too");
  });
});

test("a finite-but-out-of-range event time falls back to the ingest day instead of throwing", () => {
  withDir((dir) => {
    const path = join(dir, "s.json");
    const store = new AuditSummaryStore(path, {
      flushIntervalMs: 10_000,
      nowFn: () => Date.UTC(2025, 0, 2, 12, 0, 0), // ingest day 2025-01-02
    });
    // 1e18 ms is ~epoch nanoseconds mistaken for ms; new Date(1e18).toISOString() throws RangeError.
    assert.doesNotThrow(() => store.record(ev({ timeMs: 1e18, sandboxUid: "sbx-1" })));
    store.flush();
    const data = readAuditSummary(path)!;
    assert.equal(data.days["2025-01-02"].bySandbox["sbx-1"], 1, "out-of-range time bucketed by the ingest day, still counted");
  });
});

test("a sandbox uid equal to a prototype key does not corrupt counts", () => {
  withDir((dir) => {
    const path = join(dir, "s.json");
    const store = new AuditSummaryStore(path, { flushIntervalMs: 10_000, nowFn: () => NOW });
    // On a plain object literal, `m["constructor"] ?? 0` reads the inherited Object.constructor and
    // turns the running count into NaN (written to the file as null); the null-prototype count maps
    // keep these as ordinary keys. "__proto__" is recorded to prove it neither throws nor pollutes.
    store.record(ev({ sandboxUid: "constructor" }));
    store.record(ev({ sandboxUid: "constructor" }));
    assert.doesNotThrow(() => store.record(ev({ sandboxUid: "__proto__" })));
    store.flush();
    const day = readAuditSummary(path)!.days["2025-01-02"];
    assert.equal(day.bySandbox["constructor"], 2, "'constructor' counted as a plain key, not the inherited fn");
    assert.equal(day.total, 3, "every event counted in the daily total");
  });
});
