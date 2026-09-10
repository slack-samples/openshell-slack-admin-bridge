import { EventEmitter } from "node:events";
import { toActionRequest, type ActionRequest } from "./action-request";
import type { OpenShellClient } from "./openshell-client";
import type { StateStore } from "./state-store";
import { childLogger } from "./logger";
import { diag, DiagCode, safeError } from "./diagnostics";

const log = childLogger("poller");

// Run `fn` over `items` with at most `limit` in flight at once, preserving input
// order in the result array. A bounded pool (rather than one big Promise.all) keeps
// the gateway from being hit with one RPC per sandbox simultaneously at high counts.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const runWorker = async (): Promise<void> => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

export interface PollerEvents {
  chunk_new: (req: ActionRequest) => void;
  chunk_closed: (chunkId: string) => void;
  poll_error: (err: unknown) => void;
}

// OpenShell never pushes new proposals (the draft_policy_update stream field is never
// emitted server-side), so we poll GetDraftPolicy per sandbox on an interval.
export class Poller extends EventEmitter {
  private client: OpenShellClient;
  private store: StateStore;
  private intervalMs: number;
  private concurrency: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;

  // `concurrency` bounds how many GetDraftPolicy RPCs run in parallel per cycle. It
  // defaults to 1 (sequential, the original behavior); production passes POLL_CONCURRENCY.
  constructor(client: OpenShellClient, store: StateStore, intervalMs: number, concurrency = 1) {
    super();
    this.client = client;
    this.store = store;
    this.intervalMs = intervalMs;
    this.concurrency = Math.max(1, concurrency);
  }

  // Typed event wiring.
  override on<K extends keyof PollerEvents>(event: K, listener: PollerEvents[K]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
  override emit<K extends keyof PollerEvents>(event: K, ...args: Parameters<PollerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info({ intervalMs: this.intervalMs, concurrency: this.concurrency }, "Poller started.");
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.intervalMs);
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      this.scheduleNext();
      return;
    }
    this.inFlight = true;
    try {
      await this.pollOnce();
    } catch (err) {
      log.error({ err }, "Poll cycle failed.");
      diag(DiagCode.PollCycleFailed, { err: safeError(err) });
      this.emit("poll_error", err);
    } finally {
      this.inFlight = false;
      this.scheduleNext();
    }
  }

  async pollOnce(): Promise<void> {
    let sandboxes;
    try {
      sandboxes = await this.client.listSandboxes(true);
    } catch (err) {
      // A failed list means we cannot reason about closure this cycle; skip entirely.
      log.warn({ err }, "ListSandboxes failed; skipping cycle.");
      diag(DiagCode.ListSandboxesFailed, { err: safeError(err) });
      this.emit("poll_error", err);
      return;
    }

    const seenPending = new Set<string>();
    const polledKeys = new Set<string>();

    // Fetch every sandbox's pending draft in parallel (bounded by `concurrency`),
    // preserving input order. A per-sandbox RPC failure yields resp:null and is
    // skipped below; crucially it must NOT enter polledKeys, or the closure pass
    // would wrongly conclude its chunks were decided out-of-band.
    const named = sandboxes.filter((sb) => sb.name);
    const fetched = await mapPool(named, this.concurrency, async (sb) => {
      try {
        return { sb, resp: await this.client.getDraftPolicy(sb.name, sb.workspace, "pending") };
      } catch (err) {
        log.warn({ err, sandbox: `${sb.workspace}/${sb.name}` }, "GetDraftPolicy failed; skipping this sandbox.");
        diag(DiagCode.GetDraftPolicyFailed, { err: safeError(err) });
        return { sb, resp: null };
      }
    });

    // Apply results sequentially in sandbox order: store writes and chunk_new
    // emissions stay deterministic and free of interleaving even though the reads
    // above ran concurrently.
    for (const { sb, resp } of fetched) {
      if (!resp) continue;
      polledKeys.add(`${sb.workspace}/${sb.name}`);

      for (const chunk of resp.chunks ?? []) {
        if (chunk.status && chunk.status !== "pending") continue;
        seenPending.add(chunk.id);
        const known = this.store.get(chunk.id);
        this.store.upsertDiscovered({
          chunkId: chunk.id,
          sandboxId: sb.id,
          sandboxName: sb.name,
          workspace: sb.workspace,
          reviewToken: chunk.review_token,
        });
        // Emit for brand-new chunks, and re-emit for known chunks that never got a Slack
        // message posted (e.g. a transient postMessage failure). The index handler dedups
        // in-flight posts, so re-emitting each cycle is a safe steady-state repost retry.
        if (!known || !known.messageTs) {
          this.emit("chunk_new", toActionRequest(chunk, sb));
        }
      }
    }

    // Out-of-band closure: a chunk the store still marks pending, whose sandbox we polled
    // successfully this cycle, but which the server no longer returns as pending. Skip
    // chunks with a decision RPC in flight so we do not race and clobber the real decision.
    for (const rec of this.store.allPending()) {
      const key = `${rec.workspace}/${rec.sandboxName}`;
      if (!polledKeys.has(key)) continue;
      if (seenPending.has(rec.chunkId)) continue;
      if (this.store.isLocked(rec.chunkId)) continue;
      log.info({ chunkId: rec.chunkId, sandbox: key }, "Chunk closed out-of-band.");
      this.emit("chunk_closed", rec.chunkId);
    }
  }
}
