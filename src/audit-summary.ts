// The audit-activity summary: a small rolling counter file the capture sink
// writes and the (separate) bridge process reads to render App Home charts. The
// two processes share no memory, so this file is the only handoff. It holds
// counts, never event bodies: per UTC day we keep a total plus a breakdown by
// sandbox id and by severity. That is everything the charts need and nothing an
// audit event's (attacker-influenceable) payload could bloat.
//
// Ownership: the capture sink is the sole writer (AuditSummaryStore); the bridge
// is a read-only consumer (readAuditSummary). Writes are atomic (the StateStore
// recipe) but, unlike approvals, audit is a firehose, so flushes are coalesced on
// a timer rather than fsync-per-event.

import { readFileSync, renameSync, mkdirSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { childLogger } from "./logger";
import type { NormalizedAuditEvent } from "./capture/normalize";

const log = childLogger("audit-summary");

// Bucket for events whose OCSF metadata.uid (sandbox id) is absent, so they are
// still counted in the daily total rather than dropped.
export const UNKNOWN_SANDBOX = "unknown";
// Bucket for events with no coercible severity_id.
export const UNKNOWN_SEVERITY = "unknown";

// Rolling retention. The App Home charts show a 10-day window; keeping a bit more
// bounds the file while leaving room to widen the window later.
const DEFAULT_RETENTION_DAYS = 30;
// Coalesce a burst of audit events into at most one disk write per interval. The
// audit feed is a firehose, so (unlike the approval StateStore) we must NOT fsync
// on every event.
const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DAY_MS = 86_400_000;
// The maximum epoch-ms magnitude Date can represent; new Date(ms).toISOString() throws RangeError
// beyond it. Audit event times come from the (attacker-influenceable) event payload, so a
// finite-but-out-of-range value (e.g. epoch nanoseconds) must be guarded before it reaches dayKey.
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface DaySummary {
  total: number;
  // sandbox id (OCSF metadata.uid) -> event count; UNKNOWN_SANDBOX for null ids.
  bySandbox: Record<string, number>;
  // severity_id (as a string) -> event count; UNKNOWN_SEVERITY for null.
  bySeverity: Record<string, number>;
}

export interface AuditSummaryData {
  version: 1;
  updatedAt: number;
  // UTC "YYYY-MM-DD" -> that day's counts.
  days: Record<string, DaySummary>;
}

function emptyData(): AuditSummaryData {
  return { version: 1, updatedAt: 0, days: Object.create(null) };
}

// A fresh day bucket. The count maps are null-prototype so that a sandbox uid (or severity) equal
// to a prototype key - "constructor", "__proto__", "hasOwnProperty", ... - can't corrupt the count
// during accumulation: on a plain object literal, `m["constructor"] ?? 0` reads the inherited
// Object.constructor (making the running total NaN) and `m["__proto__"] = n` hits the proto setter
// (silently dropping the count). A null-proto map has no such inherited keys.
function emptyDay(): DaySummary {
  return { total: 0, bySandbox: Object.create(null), bySeverity: Object.create(null) };
}

// Coerce a parsed day value into a well-formed DaySummary, or null when it is not an object. This
// keeps a parseable-but-corrupt summary from making a reader throw (e.g. Object.entries on a
// missing bySandbox) and blanking the Home tab: readAuditSummary's "never break the Home tab"
// contract covers malformed shapes, not just unparseable files.
function toDaySummary(raw: unknown): DaySummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { total?: unknown; bySandbox?: unknown; bySeverity?: unknown };
  return {
    total: typeof r.total === "number" && Number.isFinite(r.total) ? r.total : 0,
    bySandbox: toCountMap(r.bySandbox),
    bySeverity: toCountMap(r.bySeverity),
  };
}

// Copy only finite-number own values into a fresh map, dropping any non-numeric garbage a
// hand-edited or corrupt file might carry. "__proto__" is skipped so it is never re-assigned.
function toCountMap(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (k === "__proto__") continue;
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

// UTC calendar day for an epoch-ms instant. "YYYY-MM-DD" sorts lexicographically
// in chronological order, which the retention prune relies on.
function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Read the audit-activity summary the capture process writes. Returns null (never
// throws) when the file is missing, empty, or unreadable: a bad or absent summary
// must never break the Home tab, it just means "no audit charts yet".
export function readAuditSummary(path: string): AuditSummaryData | null {
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf8");
    if (content.trim() === "") return null;
    const parsed = JSON.parse(content) as Partial<AuditSummaryData>;
    if (!parsed || typeof parsed !== "object" || !parsed.days || typeof parsed.days !== "object") {
      return null;
    }
    // Coerce every day into a well-formed DaySummary, dropping malformed entries, so a corrupt but
    // parseable file can never make a consumer throw (e.g. Object.entries on a missing bySandbox).
    // days is null-prototype so a crafted day key can't pollute a prototype.
    const days: Record<string, DaySummary> = Object.create(null);
    for (const [key, raw] of Object.entries(parsed.days)) {
      if (key === "__proto__") continue;
      const day = toDaySummary(raw);
      if (day) days[key] = day;
    }
    return { version: 1, updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0, days };
  } catch (err) {
    log.warn({ err, path }, "Audit summary unreadable; App Home will show no audit charts.");
    return null;
  }
}

// Accumulates captured audit events into per-day, per-sandbox and per-severity
// counts, persisted atomically to a JSON file the (separate) bridge process reads
// to render App Home charts. Owned by the capture sink.
export class AuditSummaryStore {
  private readonly path: string;
  private data: AuditSummaryData;
  private readonly nowFn: () => number;
  private readonly retentionMs: number;
  private readonly flushIntervalMs: number;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    path: string,
    opts: { nowFn?: () => number; retentionDays?: number; flushIntervalMs?: number } = {},
  ) {
    this.path = path;
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.retentionMs = (opts.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    // Reload any prior counts so restarts accumulate rather than reset. readAuditSummary returns
    // plain objects; rebuild the count maps with null prototypes here so subsequent accumulation
    // is safe against prototype-key sandbox uids (see emptyDay).
    const loaded = readAuditSummary(this.path);
    this.data = emptyData();
    if (loaded) {
      this.data.updatedAt = loaded.updatedAt;
      for (const [key, d] of Object.entries(loaded.days)) {
        this.data.days[key] = {
          total: d.total,
          bySandbox: Object.assign(Object.create(null), d.bySandbox),
          bySeverity: Object.assign(Object.create(null), d.bySeverity),
        };
      }
    }
  }

  // Count one captured (post-filter) audit event. Buckets by the event's own UTC
  // day (metadata `time`); when that is absent we fall back to the ingest time so
  // the event is still counted. Never persists synchronously: schedules a
  // coalesced flush so a firehose does not fsync per event.
  record(ev: NormalizedAuditEvent): void {
    const key = dayKey(this.bucketTimeMs(ev.timeMs));
    const day = this.data.days[key] ?? emptyDay();
    day.total += 1;
    const sandbox = ev.sandboxUid ?? UNKNOWN_SANDBOX;
    day.bySandbox[sandbox] = (day.bySandbox[sandbox] ?? 0) + 1;
    const sev = ev.severityId != null ? String(ev.severityId) : UNKNOWN_SEVERITY;
    day.bySeverity[sev] = (day.bySeverity[sev] ?? 0) + 1;
    this.data.days[key] = day;
    this.dirty = true;
    this.scheduleFlush();
  }

  // The UTC-day timestamp for an event: its own metadata time when present and representable, else
  // the ingest time. Guards against a finite-but-out-of-range time (e.g. epoch nanoseconds) that
  // would make dayKey -> new Date(ms).toISOString() throw RangeError, which would otherwise drop
  // the count and, at firehose volume, flood the log; such events fall back to the ingest day.
  private bucketTimeMs(timeMs: number | null): number {
    if (timeMs != null && Number.isFinite(timeMs) && Math.abs(timeMs) <= MAX_DATE_MS) return timeMs;
    return this.nowFn();
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushIntervalMs);
    // A pending flush must never keep the process alive on its own; shutdown flushes.
    this.timer.unref?.();
  }

  // Prune days older than the retention window, then persist atomically. Public so
  // the sink can force a final write on shutdown. No-op when nothing has changed.
  flush(): void {
    if (!this.dirty) return;
    try {
      this.pruneOldDays();
      this.data.updatedAt = this.nowFn();
      this.persist();
      this.dirty = false;
    } catch (err) {
      // The summary is a best-effort side channel; a write failure must NEVER break the audit feed.
      // Because flush() runs from a setTimeout callback (scheduleFlush), an uncaught throw here would
      // escape the timer and crash the whole capture process - the pipeline's per-event try/catch
      // only guards record(), which just mutates memory and arms the timer. So log and leave
      // dirty=true; the next event's scheduled flush (or the shutdown flush) retries.
      log.warn({ err, path: this.path }, "Audit summary flush failed; keeping counts to retry on the next event.");
    }
  }

  private pruneOldDays(): void {
    const cutoff = dayKey(this.nowFn() - this.retentionMs);
    for (const key of Object.keys(this.data.days)) {
      // "YYYY-MM-DD" sorts lexicographically in chronological order.
      if (key < cutoff) delete this.data.days[key];
    }
  }

  // Durable atomic persist, mirroring StateStore: write + fsync a temp file, rename
  // over the target, then fsync the directory so the rename survives a crash.
  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(this.data, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Directory fsync is best-effort; not supported on every platform.
    }
  }

  // Stop the flush timer and force a final write. Call on shutdown.
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
