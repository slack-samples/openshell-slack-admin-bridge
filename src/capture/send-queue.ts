// A bounded, rate-limited FIFO between the (bursty) ingestion sources and Slack.
// Slack's chat.postMessage is limited to roughly one message per second per
// channel, while the audit firehose can arrive far faster, so posts are spaced
// and 429s are honored. The queue is bounded: when full it sheds load and counts
// the drop rather than growing without limit (a silent OOM is worse than a
// logged gap). All timing is injectable so the behavior is unit-testable.

import { childLogger } from "../logger";
import type { RenderedAudit } from "./blocks";

const log = childLogger("capture-queue");

export interface SendQueueDeps {
  // Post one message. Must reject on failure; a Slack rate-limit rejection is
  // recognized via retryAfterMs() below.
  post: (msg: RenderedAudit) => Promise<void>;
  // Minimum spacing between successful sends (Slack ~1 msg/sec/channel).
  minIntervalMs?: number;
  // Max queued messages before new ones are dropped.
  maxQueue?: number;
  // Retries for a non-rate-limit failure before the message is dropped.
  maxRetries?: number;
  // Retries for a rate-limit (429) rejection before giving up. Kept SEPARATE
  // from maxRetries and larger: a 429 means "slow down", not "this event is
  // bad", so it must not consume the hard-failure budget and drop good audit
  // records during sustained throttling.
  maxRateLimitRetries?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  // Monotonic-ish clock for send spacing; injectable for deterministic tests.
  now?: () => number;
  onDrop?: (reason: "full" | "failed" | "closed", post: RenderedAudit) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

// Extract a Slack rate-limit backoff (ms) from an error, or null if it is not a
// rate-limit error. Bolt/web-api surface `retryAfter` (seconds); some shapes
// carry it on `data.retry_after` or a `Retry-After` header.
export function retryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as Record<string, unknown>;
  const isRateLimit =
    e.code === "slack_webapi_rate_limited_error" ||
    (typeof e.statusCode === "number" && e.statusCode === 429) ||
    (typeof e.status === "number" && e.status === 429);
  const secs =
    (typeof e.retryAfter === "number" && e.retryAfter) ||
    (isObj(e.data) && typeof e.data.retry_after === "number" && e.data.retry_after) ||
    headerRetryAfter(e);
  if (secs && secs > 0) return Math.ceil(secs * 1000);
  // A recognized rate-limit error with no parseable delay still needs a wait.
  return isRateLimit ? 1000 : null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function headerRetryAfter(e: Record<string, unknown>): number | null {
  const headers = isObj(e.headers) ? e.headers : undefined;
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const n = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

export class SendQueue {
  private readonly q: RenderedAudit[] = [];
  private readonly post: SendQueueDeps["post"];
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private readonly maxRetries: number;
  private readonly maxRateLimitRetries: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly onDrop?: SendQueueDeps["onDrop"];

  private running = false;
  private loopDone: Promise<void> = Promise.resolve();
  private wake: (() => void) | null = null;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private droppedFull = 0;
  private droppedFailed = 0;
  private droppedClosed = 0;

  constructor(deps: SendQueueDeps) {
    this.post = deps.post;
    this.minIntervalMs = deps.minIntervalMs ?? 1100;
    this.maxQueue = deps.maxQueue ?? 5000;
    this.maxRetries = deps.maxRetries ?? 4;
    this.maxRateLimitRetries = deps.maxRateLimitRetries ?? 20;
    this.baseBackoffMs = deps.baseBackoffMs ?? 1000;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? (() => Date.now());
    this.onDrop = deps.onDrop;
  }

  size(): number {
    return this.q.length;
  }

  stats(): { queued: number; droppedFull: number; droppedFailed: number; droppedClosed: number } {
    return {
      queued: this.q.length,
      droppedFull: this.droppedFull,
      droppedFailed: this.droppedFailed,
      droppedClosed: this.droppedClosed,
    };
  }

  // Accept a message, or return false (and count it) when the queue is full or
  // stopped. Never blocks the caller.
  enqueue(post: RenderedAudit): boolean {
    if (!this.running) {
      // Refused because the queue is stopped (or not yet started). Count it
      // separately from load-shedding so a shutdown-window gap is visible in
      // stats rather than looking like a healthy no-op.
      this.droppedClosed++;
      this.onDrop?.("closed", post);
      return false;
    }
    if (this.q.length >= this.maxQueue) {
      this.droppedFull++;
      this.onDrop?.("full", post);
      log.warn({ droppedFull: this.droppedFull, max: this.maxQueue }, "Audit queue full; dropping event.");
      return false;
    }
    this.q.push(post);
    this.wake?.();
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loopDone = this.loop();
  }

  // Stop accepting and drain what is already queued (still rate-limited), then
  // resolve. Bounded by the queue length, since enqueue is closed first.
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loopDone;
  }

  private async loop(): Promise<void> {
    // Drain until stopped AND empty, so a stop() still flushes the backlog.
    while (this.running || this.q.length > 0) {
      if (this.q.length === 0) {
        await this.waitForWork();
        continue;
      }
      // Space sends by WALL CLOCK, not by backlog depth: Slack throttles per
      // unit time, so the gap must hold even when the queue empties between
      // events. (The old "sleep only if more are queued" defeated the limit
      // for a steady trickle of one-at-a-time events.)
      const waitMs = this.minIntervalMs - (this.now() - this.lastSentAt);
      if (waitMs > 0) await this.sleep(waitMs);
      const item = this.q[0];
      await this.trySend(item);
      this.lastSentAt = this.now();
      this.q.shift();
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.wake = () => {
        this.wake = null;
        resolve();
      };
    });
  }

  private async trySend(item: RenderedAudit): Promise<void> {
    // Two independent budgets: rate-limit (429) rejections mean "slow down" and
    // draw from the larger maxRateLimitRetries pool honoring Retry-After; every
    // other failure draws from the smaller maxRetries pool with exponential
    // backoff. A burst of 429s must never exhaust the hard-failure budget and
    // drop a good audit record.
    let hardAttempts = 0;
    let rateLimitAttempts = 0;
    for (;;) {
      try {
        await this.post(item);
        return;
      } catch (err) {
        const ra = retryAfterMs(err);
        if (ra !== null) {
          if (rateLimitAttempts >= this.maxRateLimitRetries) {
            this.droppedFailed++;
            this.onDrop?.("failed", item);
            log.error(
              { err, rateLimitAttempts, droppedFailed: this.droppedFailed },
              "Audit post rate-limited past its budget; dropping event.",
            );
            return;
          }
          rateLimitAttempts++;
          log.warn({ err, rateLimitAttempts, delayMs: ra }, "Audit post rate-limited; honoring retry-after.");
          await this.sleep(ra);
        } else {
          if (hardAttempts >= this.maxRetries) {
            this.droppedFailed++;
            this.onDrop?.("failed", item);
            log.error({ err, hardAttempts, droppedFailed: this.droppedFailed }, "Audit post failed; dropping event.");
            return;
          }
          const delay = this.baseBackoffMs * 2 ** hardAttempts;
          hardAttempts++;
          log.warn({ err, hardAttempts, delayMs: delay }, "Audit post retry.");
          await this.sleep(delay);
        }
      }
    }
  }
}
