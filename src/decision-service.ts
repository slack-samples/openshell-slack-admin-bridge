import type { KnownBlock, View } from "@slack/types";
import {
  isAuthorizedAdmin,
  findAdmin,
  resolveChannel,
  type AppConfig,
} from "./config";
import { OpenShellClient, isFailedPrecondition } from "./openshell-client";
import { StateStore } from "./state-store";
import { toActionRequest, type ActionRequest } from "./action-request";
import {
  REJECT_REASON_BLOCK,
  buildApprovalBlocks,
  buildApprovalText,
  buildTerminalBlocks,
  buildTerminalText,
  buildRejectModal,
  type TerminalOutcome,
} from "./slack-messages";
import { buildAppHomeView, buildDecisionsModal } from "./app-home";
import { readAuditSummary } from "./audit-summary";
import type { Poller } from "./poller";
import { childLogger } from "./logger";
import { diag, DiagCode, chunkRef, safeError } from "./diagnostics";

const log = childLogger("decision-service");

// The Slack operations the decision logic performs directly. Backed by the Bolt Web API
// client in production; a fake in tests. Keeping this narrow lets the whole approve /
// reject / reconcile / closure flow run headlessly against a real OpenShell (or the mock)
// without a live Socket Mode connection.
export interface PostMessageResult {
  ts?: string;
  channel?: string;
}

export interface SlackSurface {
  postMessage(args: { channel: string; text: string; blocks: KnownBlock[] }): Promise<PostMessageResult>;
  updateMessage(args: { channel: string; ts: string; text: string; blocks: KnownBlock[] }): Promise<void>;
  // Resolve a canonical permalink to a posted message so the App Home can deep-link to the
  // real request. Optional (the Bolt adapter implements it; test fakes may omit it) and
  // best-effort: a rejection or undefined result just means "no link yet".
  getPermalink?(args: { channel: string; messageTs: string }): Promise<string | undefined>;
}

// The result of a decision attempt. The Bolt adapter maps a failure onto the appropriate
// Slack feedback surface (ephemeral `respond` for buttons, `chat.postEphemeral` for modals).
export type DecisionCode =
  | "not_admin"
  | "unknown"
  | "already_decided"
  | "in_flight"
  | "reason_required"
  | "error";

export interface DecisionOk {
  ok: true;
  status: "approved" | "rejected";
  policyVersion?: number;
}

export interface DecisionErr {
  ok: false;
  code: DecisionCode;
  message: string;
}

export type DecisionOutcome = DecisionOk | DecisionErr;

function fail(code: DecisionCode, message: string): DecisionErr {
  return { ok: false, code, message };
}

export type RejectModalResult = { ok: true; view: View } | DecisionErr;

export class DecisionService {
  private config: AppConfig;
  private client: OpenShellClient;
  private store: StateStore;
  private surface: SlackSurface;

  // Full request detail keyed by chunk id, needed to rebuild terminal cards and the reject
  // modal. Refilled at startup for pending records (the store keeps only coords).
  private requestCache = new Map<string, ActionRequest>();
  // Chunk ids with a chat.postMessage currently in flight, so the poller's per-cycle
  // re-emit of not-yet-posted chunks does not create duplicate messages.
  private posting = new Set<string>();

  constructor(config: AppConfig, client: OpenShellClient, store: StateStore, surface: SlackSurface) {
    this.config = config;
    this.client = client;
    this.store = store;
    this.surface = surface;
  }

  // --- Slack posting --------------------------------------------------------

  async postApproval(req: ActionRequest): Promise<void> {
    this.requestCache.set(req.chunkId, req);
    const channel = resolveChannel(this.config, req.workspace);
    try {
      const res = await this.surface.postMessage({
        channel,
        text: buildApprovalText(req),
        blocks: buildApprovalBlocks(req),
      });
      if (res.ts) {
        const postedChannel = res.channel || channel;
        // Persist the message coordinates FIRST. Duplicate-post prevention keys off a stored
        // messageTs (reconcile reposts any pending chunk without one), so the window between a
        // successful post and that write must stay ~0. The permalink lookup that follows is a
        // slow, best-effort network call; if we awaited it before writing coords, a crash or
        // SIGTERM during that await would drop the coords and repost a duplicate card.
        this.store.setMessageCoords(req.chunkId, postedChannel, res.ts);
        const permalink = await this.resolvePermalink(postedChannel, res.ts);
        if (permalink) this.store.setMessageCoords(req.chunkId, postedChannel, res.ts, permalink);
      }
      log.info({ chunkId: req.chunkId, channel, ts: res.ts }, "Posted approval request.");
    } catch (err) {
      if ((err as { data?: { error?: string } })?.data?.error === "not_in_channel") {
        // By design the bridge holds only chat:write (no channels:join), so it never self-joins.
        // The bot must be invited to the approval channel manually. We store no message coords,
        // so the poller re-emits this chunk and postApproval retries on the next cycle, which
        // succeeds once the invite lands (no restart needed).
        log.error(
          { chunkId: req.chunkId, channel },
          "Bot is not in the approval channel. Invite it (/invite @openshell_admin); the post retries on the next poll.",
        );
        diag(DiagCode.PostNotInChannel, { chunkRef: chunkRef(req.chunkId) });
        return;
      }
      log.error({ err, chunkId: req.chunkId, channel }, "Failed to post approval request.");
      diag(DiagCode.PostFailed, { chunkRef: chunkRef(req.chunkId), err: safeError(err) });
    }
  }

  // Best-effort permalink lookup for a freshly posted message. A missing method or a failed
  // lookup returns undefined so posting never fails on a cosmetic deep-link; the App Home
  // falls back to a plain channel reference in that case.
  private async resolvePermalink(channel: string, messageTs: string): Promise<string | undefined> {
    if (!this.surface.getPermalink) return undefined;
    try {
      return await this.surface.getPermalink({ channel, messageTs });
    } catch (err) {
      log.warn({ err, channel, messageTs }, "getPermalink failed; App Home will fall back to a channel reference.");
      return undefined;
    }
  }

  async renderTerminal(chunkId: string, outcome: TerminalOutcome): Promise<void> {
    const rec = this.store.get(chunkId);
    if (!rec?.channelId || !rec.messageTs) return;
    const req =
      this.requestCache.get(chunkId) ??
      // Minimal fallback if the request detail is not cached (e.g. closure after restart).
      ({
        kind: "network",
        chunkId,
        status: outcome.status,
        sandboxId: rec.sandboxId,
        sandboxName: rec.sandboxName,
        workspace: rec.workspace,
        reviewToken: "",
        ruleName: "(rule)",
        endpoints: [],
        binaries: [],
        rationale: "",
        securityNotes: "",
        validationResult: "",
        confidence: 0,
        proposerType: "mechanistic",
        securityFlagged: false,
        hitCount: 0,
        denialCount: 0,
      } as ActionRequest);
    try {
      await this.surface.updateMessage({
        channel: rec.channelId,
        ts: rec.messageTs,
        text: buildTerminalText(req, outcome),
        blocks: buildTerminalBlocks(req, outcome),
      });
    } catch (err) {
      log.error({ err, chunkId }, "Failed to update message to terminal state.");
      diag(DiagCode.TerminalUpdateFailed, { chunkRef: chunkRef(chunkId), err: safeError(err) });
    }
  }

  // --- Approve --------------------------------------------------------------

  async approve(userId: string, chunkId: string | undefined): Promise<DecisionOutcome> {
    if (!isAuthorizedAdmin(this.config, userId)) return fail("not_admin", "You are not an authorized admin.");
    if (!chunkId) return fail("unknown", "This request is unknown or expired.");
    const rec = this.store.get(chunkId);
    if (!rec) return fail("unknown", "This request is unknown or expired.");
    if (this.store.isTerminal(chunkId)) return fail("already_decided", "This request was already decided.");
    if (!this.store.tryLock(chunkId, userId)) return fail("in_flight", "This request is already being decided.");

    const admin = findAdmin(this.config, userId);
    try {
      const version = await this.approveWithRetry(chunkId);
      this.store.markTerminal(chunkId, "approved", {
        decidedBy: userId,
        decidedByName: admin?.name,
        policyVersion: version,
      });
      await this.renderTerminal(chunkId, {
        status: "approved",
        byUserId: userId,
        policyVersion: version,
        whenIso: new Date().toISOString(),
      });
      return { ok: true, status: "approved", policyVersion: version };
    } catch (err) {
      this.store.unlock(chunkId);
      log.error({ err, chunkId }, "Approve failed.");
      diag(DiagCode.ApproveFailed, { chunkRef: chunkRef(chunkId), err: safeError(err) });
      return fail("error", `Could not approve: ${(err as Error).message}. The proposal may have changed; try again.`);
    }
  }

  // Approve, refreshing the review_token once on FAILED_PRECONDITION (stale token).
  private async approveWithRetry(chunkId: string): Promise<number | undefined> {
    const rec = this.store.get(chunkId);
    if (!rec) throw new Error("record vanished");
    try {
      const res = await this.client.approveDraftChunk(
        rec.sandboxName,
        chunkId,
        rec.reviewToken ?? "",
        rec.workspace,
      );
      return res.policy_version;
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
      log.warn({ chunkId }, "Stale review_token; refreshing and retrying once.");
      diag(DiagCode.StaleReviewToken, { chunkRef: chunkRef(chunkId), retry: 1 });
      const resp = await this.client.getDraftPolicy(rec.sandboxName, rec.workspace, "pending");
      const fresh = resp.chunks?.find((c) => c.id === chunkId);
      if (!fresh?.review_token) throw new Error("proposal no longer pending");
      this.store.upsertDiscovered({
        chunkId,
        sandboxId: rec.sandboxId,
        sandboxName: rec.sandboxName,
        workspace: rec.workspace,
        reviewToken: fresh.review_token,
      });
      const res = await this.client.approveDraftChunk(rec.sandboxName, chunkId, fresh.review_token, rec.workspace);
      return res.policy_version;
    }
  }

  // --- Reject ---------------------------------------------------------------

  // Pure validation for the reject modal's inline errors (ack response_action). Returns the
  // block id + message to surface, or null when the submission is valid.
  validateRejectSubmission(userId: string, reason: string): { block: string; error: string } | null {
    if (!isAuthorizedAdmin(this.config, userId)) {
      return { block: REJECT_REASON_BLOCK, error: "You are not an authorized admin." };
    }
    if (this.config.settings.rejectReasonRequired && !reason.trim()) {
      return { block: REJECT_REASON_BLOCK, error: "A reason is required." };
    }
    return null;
  }

  // Build the reject modal for a chunk (authz + liveness gated). The adapter supplies the
  // Bolt trigger_id and opens the returned view.
  rejectModalFor(userId: string, chunkId: string | undefined): RejectModalResult {
    if (!isAuthorizedAdmin(this.config, userId)) return fail("not_admin", "You are not an authorized admin.");
    const rec = chunkId ? this.store.get(chunkId) : undefined;
    if (!chunkId || !rec) return fail("unknown", "This request is unknown or expired.");
    if (this.store.isTerminal(chunkId)) return fail("already_decided", "This request was already decided.");
    const view = buildRejectModal(
      { chunkId, channelId: rec.channelId ?? "", messageTs: rec.messageTs ?? "" },
      this.requestCache.get(chunkId)?.ruleName ?? "this egress",
      this.config.settings.rejectReasonRequired,
    );
    return { ok: true, view };
  }

  async reject(userId: string, chunkId: string | undefined, reason: string): Promise<DecisionOutcome> {
    const trimmed = (reason ?? "").trim();
    if (!isAuthorizedAdmin(this.config, userId)) return fail("not_admin", "You are not an authorized admin.");
    if (this.config.settings.rejectReasonRequired && !trimmed) return fail("reason_required", "A reason is required.");
    if (!chunkId) return fail("unknown", "This request is unknown or expired.");
    const rec = this.store.get(chunkId);
    if (!rec) return fail("unknown", "This request is unknown or expired.");
    if (this.store.isTerminal(chunkId)) return fail("already_decided", "This request was already decided.");
    if (!this.store.tryLock(chunkId, userId)) return fail("in_flight", "This request is already being decided.");

    const admin = findAdmin(this.config, userId);
    try {
      await this.client.rejectDraftChunk(rec.sandboxName, chunkId, trimmed, rec.workspace);
      this.store.markTerminal(chunkId, "rejected", {
        decidedBy: userId,
        decidedByName: admin?.name,
        rejectReason: trimmed,
      });
      await this.renderTerminal(chunkId, {
        status: "rejected",
        byUserId: userId,
        reason: trimmed,
        whenIso: new Date().toISOString(),
      });
      return { ok: true, status: "rejected" };
    } catch (err) {
      this.store.unlock(chunkId);
      log.error({ err, chunkId }, "Reject failed.");
      diag(DiagCode.RejectFailed, { chunkRef: chunkRef(chunkId), err: safeError(err) });
      return fail("error", `Could not reject: ${(err as Error).message}.`);
    }
  }

  // --- Poller wiring --------------------------------------------------------

  // Post a newly discovered chunk. Skips if already posted or a post is in flight (the
  // poller re-emits every cycle until a message lands, which is how a failed post retries).
  // Returns the in-flight post promise so callers/tests can await completion.
  handleChunkNew(req: ActionRequest): Promise<void> {
    this.requestCache.set(req.chunkId, req);
    if (this.store.get(req.chunkId)?.messageTs || this.posting.has(req.chunkId)) return Promise.resolve();
    this.posting.add(req.chunkId);
    return this.postApproval(req).finally(() => this.posting.delete(req.chunkId));
  }

  handleChunkClosed(chunkId: string): Promise<void> {
    // A decision may have landed between the poller emitting and this handler running.
    if (this.store.isTerminal(chunkId) || this.store.isLocked(chunkId)) return Promise.resolve();
    this.store.markTerminal(chunkId, "closed");
    return this.renderTerminal(chunkId, { status: "closed", whenIso: new Date().toISOString() });
  }

  attachPoller(poller: Poller): void {
    poller.on("chunk_new", (req) => void this.handleChunkNew(req));
    poller.on("chunk_closed", (chunkId) => void this.handleChunkClosed(chunkId));
  }

  // --- App Home -------------------------------------------------------------

  // `opts` selects how much of the modern view to render: `charts === false` omits the native
  // data_visualization Analytics section entirely, `kpiTable === false` swaps the newer KPI `table`
  // block for a one-line strip (keeping the carousel), and `carousel === false` builds the GA-only
  // fallback (no carousel/card blocks). The App Home publish path steps through these tiers when a
  // richer views.publish is rejected.
  homeViewFor(userId: string, opts: { carousel?: boolean; kpiTable?: boolean; charts?: boolean } = {}): View {
    // The queue reveals sandbox inventory and in-flight security decisions, so only show it
    // to authorized admins; everyone else gets a minimal notice.
    if (!isAuthorizedAdmin(this.config, userId)) {
      return {
        type: "home",
        blocks: [
          { type: "header", text: { type: "plain_text", text: "OpenShell egress approvals", emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: ":lock: This view is for admins only." } },
        ],
      };
    }
    // The request cache carries the rich per-chunk detail (endpoints, confidence, security
    // flag) the durable store does not; config supplies the admin roster and routing. The audit
    // summary is read fresh each time (the capture process, if running, writes it out-of-band):
    // Home opens are infrequent, so this always reflects the latest counts and never throws.
    return buildAppHomeView({
      records: this.store.all(),
      detail: this.requestCache,
      config: this.config,
      now: Date.now(),
      audit: readAuditSummary(this.config.capture.summaryStatePath) ?? undefined,
      carousel: opts.carousel,
      kpiTable: opts.kpiTable,
      charts: opts.charts,
    });
  }

  // Build the "Approvals vs rejections" modal opened from the Home Analytics button (authz
  // gated; the button only renders for admins, so a non-admin reaching here is a stale client).
  // The modal is chartless (data_visualization does not render in modal views) and built entirely
  // from GA blocks, so it always opens. Reads the durable store + request cache like homeViewFor.
  decisionsModalFor(userId: string): RejectModalResult {
    if (!isAuthorizedAdmin(this.config, userId)) return fail("not_admin", "You are not an authorized admin.");
    const view = buildDecisionsModal({
      records: this.store.all(),
      detail: this.requestCache,
      now: Date.now(),
    });
    return { ok: true, view };
  }

  // --- Startup reconciliation -----------------------------------------------
  // Refill the render cache for all pending chunks and repost any pending record that never
  // got a Slack message (crash between discovery and post).
  async reconcile(): Promise<void> {
    let sandboxes;
    try {
      sandboxes = await this.client.listSandboxes(true);
    } catch (err) {
      log.error({ err }, "Reconcile: ListSandboxes failed; the poller will retry.");
      diag(DiagCode.ReconcileListFailed, { err: safeError(err) });
      return;
    }
    for (const sb of sandboxes) {
      if (!sb.name) continue;
      let resp;
      try {
        resp = await this.client.getDraftPolicy(sb.name, sb.workspace, "pending");
      } catch (err) {
        log.warn({ err, sandbox: sb.name }, "Reconcile: GetDraftPolicy failed for sandbox.");
        diag(DiagCode.ReconcileGetDraftFailed, { err: safeError(err) });
        continue;
      }
      for (const chunk of resp.chunks ?? []) {
        if (chunk.status && chunk.status !== "pending") continue;
        const req = toActionRequest(chunk, sb);
        this.requestCache.set(chunk.id, req);
        const known = this.store.get(chunk.id);
        this.store.upsertDiscovered({
          chunkId: chunk.id,
          sandboxId: sb.id,
          sandboxName: sb.name,
          workspace: sb.workspace,
          reviewToken: chunk.review_token,
        });
        if (!known || !known.messageTs) {
          await this.postApproval(req);
        } else if (!known.permalink && known.channelId) {
          // Backfill a permalink for a message posted before this feature existed (or when an
          // earlier lookup failed), so the App Home can deep-link without reposting the card.
          const permalink = await this.resolvePermalink(known.channelId, known.messageTs);
          if (permalink) this.store.setMessageCoords(chunk.id, known.channelId, known.messageTs, permalink);
        }
      }
    }
    log.info({ pending: this.store.allPending().length }, "Reconcile complete.");
  }
}
