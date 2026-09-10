import { readFileSync, renameSync, mkdirSync, existsSync, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { childLogger } from "./logger";
import { diag, DiagCode, safeError } from "./diagnostics";

const log = childLogger("state-store");

export type ChunkStatus = "pending" | "approved" | "rejected" | "closed";

// One durable record per draft chunk. The bridge owns the Slack message coordinates
// and the approver identity (OpenShell carries neither on the wire).
export interface ChunkRecord {
  chunkId: string;
  sandboxId: string;
  sandboxName: string;
  workspace: string;
  // Slack message coordinates for chat.update after a decision or out-of-band closure.
  channelId?: string;
  messageTs?: string;
  // Canonical permalink to the approval message (from chat.getPermalink), captured at post
  // time so the App Home dashboard can deep-link to the actual request.
  permalink?: string;
  // Optimistic-concurrency token captured at last poll (FR: ApproveDraftChunk field 4).
  reviewToken?: string;
  status: ChunkStatus;
  // In-flight idempotency lock: set while a decision RPC is outstanding.
  lockedBy?: string;
  lockedAt?: number;
  // Terminal decision metadata (bridge-owned; OpenShell has no decided_by).
  decidedBy?: string;
  decidedByName?: string;
  decidedAt?: number;
  rejectReason?: string;
  policyVersion?: number;
  createdAt: number;
  updatedAt: number;
}

interface StateFile {
  version: 1;
  chunks: Record<string, ChunkRecord>;
}

const TERMINAL: ChunkStatus[] = ["approved", "rejected", "closed"];
// A lock older than this is treated as stale (crash mid-decision) and reclaimable.
const LOCK_TTL_MS = 60_000;

export class StateStore {
  private path: string;
  private data: StateFile;
  private nowFn: () => number;

  constructor(path: string, nowFn: () => number = () => Date.now()) {
    this.path = path;
    this.nowFn = nowFn;
    this.data = { version: 1, chunks: {} };
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      log.info({ path: this.path }, "No existing state file; starting fresh.");
      return;
    }
    try {
      const content = readFileSync(this.path, "utf8");
      // A zero-length file can result from a crash mid-write; treat it as fresh rather
      // than dying on JSON.parse("") every startup.
      if (content.trim() === "") {
        log.warn({ path: this.path }, "State file is empty; starting fresh.");
        return;
      }
      const parsed = JSON.parse(content) as StateFile;
      if (parsed && parsed.chunks) {
        this.data = { version: 1, chunks: parsed.chunks };
      }
      log.info({ path: this.path, count: Object.keys(this.data.chunks).length }, "Loaded state.");
    } catch (err) {
      log.error({ path: this.path, err }, "State file unreadable; refusing to overwrite. Fix or remove it.");
      diag(DiagCode.StateFileUnreadable, { err: safeError(err) });
      throw err;
    }
  }

  // Durable atomic persist: write + fsync a temp file, rename over the target, then
  // fsync the directory so the rename itself survives a crash. Rename is atomic but not
  // durable without these fsyncs (a power loss can otherwise leave a zero-length file).
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

  get(chunkId: string): ChunkRecord | undefined {
    return this.data.chunks[chunkId];
  }

  all(): ChunkRecord[] {
    return Object.values(this.data.chunks);
  }

  allPending(): ChunkRecord[] {
    return this.all().filter((r) => r.status === "pending");
  }

  isTerminal(chunkId: string): boolean {
    const r = this.get(chunkId);
    return r ? TERMINAL.includes(r.status) : false;
  }

  // True while a decision RPC is actively in flight (non-stale lock held).
  isLocked(chunkId: string): boolean {
    const r = this.get(chunkId);
    if (!r?.lockedBy || !r.lockedAt) return false;
    return this.nowFn() - r.lockedAt < LOCK_TTL_MS;
  }

  // Insert a newly discovered chunk, or refresh the review_token / sandbox fields of an
  // existing one. Never downgrades a terminal record back to pending.
  upsertDiscovered(input: {
    chunkId: string;
    sandboxId: string;
    sandboxName: string;
    workspace: string;
    reviewToken?: string;
  }): ChunkRecord {
    const now = this.nowFn();
    const existing = this.data.chunks[input.chunkId];
    if (existing) {
      existing.sandboxId = input.sandboxId;
      existing.sandboxName = input.sandboxName;
      existing.workspace = input.workspace;
      if (input.reviewToken) existing.reviewToken = input.reviewToken;
      existing.updatedAt = now;
      this.persist();
      return existing;
    }
    const record: ChunkRecord = {
      chunkId: input.chunkId,
      sandboxId: input.sandboxId,
      sandboxName: input.sandboxName,
      workspace: input.workspace,
      reviewToken: input.reviewToken,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.data.chunks[input.chunkId] = record;
    this.persist();
    return record;
  }

  setMessageCoords(chunkId: string, channelId: string, messageTs: string, permalink?: string): void {
    const r = this.data.chunks[chunkId];
    if (!r) return;
    r.channelId = channelId;
    r.messageTs = messageTs;
    // Only overwrite the permalink when we actually resolved one; a failed getPermalink
    // (undefined) must not clobber a link captured on an earlier post.
    if (permalink) r.permalink = permalink;
    r.updatedAt = this.nowFn();
    this.persist();
  }

  // Acquire the in-flight lock for a decision. Returns false if the chunk is already
  // terminal or another decision is actively in flight (idempotency).
  tryLock(chunkId: string, userId: string): boolean {
    const r = this.data.chunks[chunkId];
    if (!r) return false;
    if (TERMINAL.includes(r.status)) return false;
    const now = this.nowFn();
    if (r.lockedBy && r.lockedAt && now - r.lockedAt < LOCK_TTL_MS) {
      return false;
    }
    r.lockedBy = userId;
    r.lockedAt = now;
    r.updatedAt = now;
    this.persist();
    return true;
  }

  unlock(chunkId: string): void {
    const r = this.data.chunks[chunkId];
    if (!r) return;
    delete r.lockedBy;
    delete r.lockedAt;
    r.updatedAt = this.nowFn();
    this.persist();
  }

  // Drop terminal (approved/rejected/closed) records decided longer than `maxAgeMs`
  // ago, bounding the state file's growth over time. Pending and locked records are
  // never pruned. Returns the number removed; persists once if anything changed.
  pruneTerminal(maxAgeMs: number): number {
    const cutoff = this.nowFn() - maxAgeMs;
    let removed = 0;
    for (const [id, r] of Object.entries(this.data.chunks)) {
      if (!TERMINAL.includes(r.status)) continue;
      // decidedAt is set on every terminal write; fall back to updatedAt defensively.
      const decidedAt = r.decidedAt ?? r.updatedAt;
      if (decidedAt < cutoff) {
        delete this.data.chunks[id];
        removed += 1;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  markTerminal(
    chunkId: string,
    status: "approved" | "rejected" | "closed",
    extra: { decidedBy?: string; decidedByName?: string; rejectReason?: string; policyVersion?: number } = {},
  ): void {
    const r = this.data.chunks[chunkId];
    if (!r) return;
    // First terminal write wins: never let a later out-of-band "closed" clobber a real
    // approve/reject decision (or vice versa).
    if (TERMINAL.includes(r.status)) return;
    r.status = status;
    r.decidedBy = extra.decidedBy ?? r.decidedBy;
    r.decidedByName = extra.decidedByName ?? r.decidedByName;
    r.rejectReason = extra.rejectReason ?? r.rejectReason;
    r.policyVersion = extra.policyVersion ?? r.policyVersion;
    r.decidedAt = this.nowFn();
    delete r.lockedBy;
    delete r.lockedAt;
    r.updatedAt = r.decidedAt;
    this.persist();
  }
}
