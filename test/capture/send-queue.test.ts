import { test } from "node:test";
import assert from "node:assert/strict";
import { SendQueue, retryAfterMs } from "../../src/capture/send-queue";
import type { RenderedAudit } from "../../src/capture/blocks";

function msg(text: string): RenderedAudit {
  return { text, blocks: [] };
}

// A promise that never settles until released; used to hold a send in flight.
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("enqueue is refused before the queue is started", () => {
  const q = new SendQueue({ post: async () => {} });
  assert.equal(q.enqueue(msg("a")), false);
});

test("messages drain in FIFO order, spaced by the minimum interval", async () => {
  const posts: string[] = [];
  const sleeps: number[] = [];
  // Fake clock: spacing is now measured against wall time, so a sleep must
  // advance the clock for the next gap to be computed correctly.
  let clock = 0;
  const q = new SendQueue({
    post: async (m) => {
      posts.push(m.text);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    minIntervalMs: 50,
  });
  q.start();
  assert.equal(q.enqueue(msg("a")), true);
  q.enqueue(msg("b"));
  q.enqueue(msg("c"));
  await q.stop();

  assert.deepEqual(posts, ["a", "b", "c"]);
  // First send is immediate; the two following it each wait a full interval.
  assert.deepEqual(
    sleeps.filter((s) => s === 50),
    [50, 50],
  );
});

test("spacing holds for a trickle that drains to empty between sends", async () => {
  // Regression: the old queue only slept when another item was already queued,
  // so a steady one-at-a-time trickle blew past the rate limit. With wall-clock
  // spacing, an event that arrives after an idle gap still waits its interval.
  const posts: string[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const q = new SendQueue({
    post: async (m) => {
      posts.push(m.text);
    },
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    minIntervalMs: 1000,
  });
  q.start();
  // First event: immediate (no prior send).
  q.enqueue(msg("a"));
  await new Promise((r) => setImmediate(r)); // let the loop post "a" and idle
  assert.deepEqual(posts, ["a"]);
  // Second event arrives 200ms of wall time later, well inside the interval.
  clock += 200;
  q.enqueue(msg("b"));
  await q.stop();

  assert.deepEqual(posts, ["a", "b"]);
  // "b" must wait out the remainder of the interval (1000 - 200 = 800ms).
  assert.deepEqual(sleeps, [800]);
});

test("stop() flushes the backlog before resolving", async () => {
  const posts: string[] = [];
  const q = new SendQueue({
    post: async (m) => {
      posts.push(m.text);
    },
    sleep: async () => {},
  });
  q.start();
  for (const t of ["1", "2", "3", "4"]) q.enqueue(msg(t));
  await q.stop();
  assert.deepEqual(posts, ["1", "2", "3", "4"]);
  assert.equal(q.size(), 0);
});

test("a full queue sheds new messages and counts the drop", async () => {
  const gate = deferred();
  const dropped: string[] = [];
  const q = new SendQueue({
    post: async () => {
      await gate.promise; // hold the first send in flight
    },
    sleep: async () => {},
    maxQueue: 2,
    onDrop: (reason, m) => {
      if (reason === "full") dropped.push(m.text);
    },
  });
  q.start();
  // "a" is pulled into the in-flight send but remains counted until it completes;
  // "b" fills the queue; "c" overflows.
  assert.equal(q.enqueue(msg("a")), true);
  assert.equal(q.enqueue(msg("b")), true);
  assert.equal(q.enqueue(msg("c")), false);
  assert.equal(q.stats().droppedFull, 1);
  assert.deepEqual(dropped, ["c"]);

  gate.resolve();
  await q.stop();
});

test("a transient failure is retried with exponential backoff, then succeeds", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const q = new SendQueue({
    post: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    baseBackoffMs: 100,
    maxRetries: 3,
  });
  q.start();
  q.enqueue(msg("a"));
  await q.stop();

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [100]); // base * 2**0
  assert.equal(q.stats().droppedFailed, 0);
});

test("a message is dropped after exhausting its retries", async () => {
  let calls = 0;
  const q = new SendQueue({
    post: async () => {
      calls++;
      throw new Error("always");
    },
    sleep: async () => {},
    maxRetries: 2,
    baseBackoffMs: 10,
  });
  q.start();
  q.enqueue(msg("a"));
  await q.stop();

  assert.equal(calls, 3); // attempts 0,1,2 then give up
  assert.equal(q.stats().droppedFailed, 1);
});

test("a rate-limit error waits the server-specified retry-after", async () => {
  let calls = 0;
  const sleeps: number[] = [];
  const rlErr = Object.assign(new Error("rate limited"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: 2,
  });
  const q = new SendQueue({
    post: async () => {
      calls++;
      if (calls === 1) throw rlErr;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  q.start();
  q.enqueue(msg("a"));
  await q.stop();

  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]); // 2 seconds honored
});

test("a sustained rate-limit does not consume the hard-failure budget", async () => {
  // Four consecutive 429s far exceed maxRetries; because rate-limit retries are
  // budgeted separately, the good record is still delivered rather than dropped.
  let calls = 0;
  const rlErr = Object.assign(new Error("rate limited"), {
    code: "slack_webapi_rate_limited_error",
    retryAfter: 1,
  });
  const q = new SendQueue({
    post: async () => {
      calls++;
      if (calls <= 4) throw rlErr;
    },
    sleep: async () => {},
    maxRetries: 1, // tiny hard-failure budget
    maxRateLimitRetries: 10, // generous rate-limit budget
  });
  q.start();
  q.enqueue(msg("a"));
  await q.stop();

  assert.equal(calls, 5); // retried through all four 429s, then posted
  assert.equal(q.stats().droppedFailed, 0);
});

test("enqueue after stop counts a closed drop", async () => {
  const q = new SendQueue({ post: async () => {}, sleep: async () => {} });
  q.start();
  await q.stop();
  assert.equal(q.enqueue(msg("late")), false);
  assert.equal(q.stats().droppedClosed, 1);
});

// ---- retryAfterMs unit coverage ----------------------------------------

test("retryAfterMs recognizes the Slack rate-limit shapes", () => {
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs(new Error("plain")), null);
  assert.equal(retryAfterMs({ statusCode: 500 }), null);

  assert.equal(retryAfterMs({ code: "slack_webapi_rate_limited_error", retryAfter: 3 }), 3000);
  assert.equal(retryAfterMs({ statusCode: 429, data: { retry_after: 5 } }), 5000);
  assert.equal(retryAfterMs({ status: 429, headers: { "retry-after": "7" } }), 7000);
  // A recognized rate-limit error with no parseable delay still yields a wait.
  assert.equal(retryAfterMs({ statusCode: 429 }), 1000);
});
