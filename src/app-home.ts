import type { KnownBlock, AnyBlock, View, Block, CardBlock, CarouselBlock, Button } from "@slack/types";
import type { ChunkRecord } from "./state-store";
import type { ActionRequest } from "./action-request";
import type { AppConfig } from "./config";
import { type AuditSummaryData, UNKNOWN_SANDBOX } from "./audit-summary";
import { truncate } from "./slack-text";
import {
  ACTION_APPROVE,
  ACTION_REJECT,
  ACTION_OPEN_REQUEST,
  ACTION_VIEW_DECISIONS,
  DECISIONS_MODAL_CALLBACK,
} from "./slack-messages";

const MAX_BLOCKS = 100;
const MAX_PENDING = 20;
// A carousel accepts at most 10 cards; older pending requests overflow into a context note.
const MAX_CAROUSEL_CARDS = 10;
// Card field ceilings from the Block Kit card spec: title/subtitle 150 chars, body 200.
const CARD_TITLE = 150;
const CARD_SUBTITLE = 150;
const CARD_BODY = 200;
// The audit trail shows only the most-recent decisions inline (the mock's trimmed "Recent
// decisions" list); the full history stays in the state file, surfaced by the "showing N of M"
// note beneath the list.
const MAX_RECENT_DECISIONS = 3;
// The decisions modal (opened from the Analytics button) has room for a fuller trail than the Home
// tab's inline 3; it still caps well under the 100-block modal ceiling.
const MAX_MODAL_DECISIONS = 10;
// Rows shown per decisions-modal breakdown (by reviewer / sandbox / rule) before an overflow note.
const MODAL_BREAKDOWN_ROWS = 8;
export const ACTIVITY_DAYS = 10;
const DAY_MS = 86_400_000;
// Top-N sandboxes plotted in the native activity bar chart; the rest are summed out of view.
export const MAX_SANDBOX_BARS = 6;

// data_visualization renders native, theme-aware charts on the Home tab. It is newer than the
// pinned @slack/types (2.22 types `carousel` but not this block), so we model it locally and
// splice it in as an AnyBlock; Block Kit validates the shape server-side. It is the one block a
// Home surface is most likely to reject, so the Analytics section is gated on `input.charts` and
// omitted wholesale when the publish path's charts-dropped tier is reached (there is no fallback
// chart; the tab simply carries no analytics).
interface ChartPoint {
  label: string;
  value: number;
}
interface ChartSeries {
  name: string;
  data: ChartPoint[];
}
interface DataVisualizationBlock extends Block {
  type: "data_visualization";
  title?: string;
  chart: {
    type: "line" | "bar";
    series: ChartSeries[];
    axis_config?: { categories?: string[]; x_label?: string; y_label?: string };
  };
}

export interface AppHomeInput {
  records: ChunkRecord[];
  // Rich per-chunk detail (endpoints, rationale, confidence, security flag) held in the
  // service's request cache. Present for chunks seen this process lifetime; it may be
  // absent for history rows decided before a restart, so every read here is optional.
  detail: Map<string, ActionRequest>;
  config: AppConfig;
  // "Now" in epoch ms, anchoring the fixed activity window. Defaults to Date.now(); tests pass a
  // fixed value so the window is deterministic.
  now?: number;
  // Render the pending queue as a carousel of cards (the modern default). Set false to fall back
  // to the GA section + context stack the publish path retries with when a views.publish carrying
  // the carousel is rejected. Independent of `charts` and `kpiTable`.
  carousel?: boolean;
  // Render the KPI row as a native `table` block (the modern default). Set false to fall back to
  // the one-line section strip while keeping the carousel; the publish path retries with this when
  // the (newer) table block is rejected but the carousel is not. Ignored when carousel === false
  // (the GA-only view always uses the strip).
  kpiTable?: boolean;
  // Render the native data_visualization Analytics section (the modern default). Set false when
  // the surface rejects data_visualization: the Analytics section is then omitted entirely, with
  // no fallback chart, leaving egress approvals, Pending approvals, Recent decisions and
  // Configuration. Independent of `carousel` and `kpiTable`.
  charts?: boolean;
  // Per-day audit-activity counts (by sandbox + severity) the capture sink writes and the bridge
  // reads; feeds the "Top sandboxes by activity" bar chart and the daily audit-volume line chart.
  // Absent when capture has never run or the summary file is unreadable, in which case those two
  // charts are simply omitted. Independent of `charts` (which gates the whole Analytics section).
  audit?: AuditSummaryData;
}

function iso(ms?: number): string {
  if (!ms) return "unknown";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function header(text: string): KnownBlock {
  return { type: "header", text: { type: "plain_text", text: truncate(text, 150), emoji: true } };
}

function section(text: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: truncate(text, 3000) } };
}

function context(text: string): KnownBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text: truncate(text, 3000) }] };
}

function endpointLine(d?: ActionRequest): string {
  if (!d || !d.endpoints.length) return "_endpoints unavailable_";
  return d.endpoints
    .map((e) => `\`${e.host}\` port ${e.ports} (${e.protocol})${e.l7 ? ` · L7 ${e.l7}` : ""}`)
    .join(", ");
}

function proposerLabel(d?: ActionRequest): string {
  if (!d) return "unknown proposer";
  return d.proposerType === "mechanistic"
    ? "mechanistic (deterministic)"
    : `agent-authored (${Math.round(d.confidence * 100)}% confidence)`;
}

// One pending request rendered as a rich card: a single section (identity, egress, proposer,
// denials, age, where it was posted) plus a security-notes context line when flagged.
function pendingBlocks(r: ChunkRecord, d?: ActionRequest): KnownBlock[] {
  const flagged = !!d?.securityFlagged;
  const icon = flagged ? ":warning:" : ":hourglass_flowing_sand:";
  const rule = d?.ruleName ?? "(egress rule)";
  const stageTag = d?.stage && d.stage !== "initial" ? ` · stage \`${d.stage}\`` : "";
  // Deep-link straight to the approval message when we captured its permalink; fall back to a
  // plain channel reference (older records, or a permalink lookup that failed) and finally to
  // "not yet posted" before the card reaches a channel.
  const where = r.permalink
    ? `<${r.permalink}|:link: open request>`
    : r.channelId
      ? `posted in <#${r.channelId}>`
      : "_not yet posted to a channel_";
  const denials = d ? `${d.hitCount} hit(s), ${d.denialCount} summary(ies)` : "unknown";

  const text = [
    `${icon} *${rule}*   \`${r.chunkId}\`${stageTag}`,
    `*Sandbox:* ${r.sandboxName}    *Workspace:* \`${r.workspace}\``,
    `*Egress:* ${endpointLine(d)}`,
    `*Proposer:* ${proposerLabel(d)}    *Denials:* ${denials}`,
    `*Seen:* ${iso(r.createdAt)}    ·    ${where}`,
  ].join("\n");

  const blocks: KnownBlock[] = [section(text)];
  if (flagged && d?.securityNotes) {
    blocks.push(context(`:warning: *Security review:* ${truncate(d.securityNotes, 400)}`));
  }
  return blocks;
}

function mrkdwn(text: string): { type: "mrkdwn"; text: string } {
  return { type: "mrkdwn", text };
}

// The Approve / Reject / (optional) Open buttons that live at the bottom of a pending card.
// Approve and Reject reuse the exact channel-message action ids and `value` contract, so the
// existing Bolt handlers fire from the Home tab with no new routing. The Open button carries a
// url (deep-link to the channel request) and is acked-only by ACTION_OPEN_REQUEST.
function pendingCardActions(r: ChunkRecord, d?: ActionRequest): Button[] {
  const rule = d?.ruleName ?? "(egress rule)";
  const actions: Button[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Approve", emoji: true },
      style: "primary",
      action_id: ACTION_APPROVE,
      value: r.chunkId,
      confirm: {
        title: { type: "plain_text", text: "Approve egress?" },
        text: mrkdwn(
          // Slack caps confirm-dialog text at 300 chars; sandbox names can be long.
          truncate(
            `This merges *${rule}* into the *${r.workspace}* policy for sandbox *${r.sandboxName}* and hot-reloads it.`,
            300,
          ),
        ),
        confirm: { type: "plain_text", text: "Approve" },
        deny: { type: "plain_text", text: "Cancel" },
      },
    },
    {
      type: "button",
      text: { type: "plain_text", text: "Reject", emoji: true },
      style: "danger",
      action_id: ACTION_REJECT,
      value: r.chunkId,
    },
  ];
  // Deep-link to the posted request when we captured its permalink; a url button opens the
  // channel message where full rationale/validation context lives.
  if (r.permalink) {
    actions.push({
      type: "button",
      text: { type: "plain_text", text: "Open request", emoji: true },
      url: r.permalink,
      action_id: ACTION_OPEN_REQUEST,
      value: r.chunkId,
    });
  }
  return actions;
}

// One pending request as a carousel card. The card's tight field limits (title/subtitle 150,
// body 200) mean the card is a scannable summary; full rationale, binaries and validation stay
// on the channel message the Open button links to. Security-flagged requests lead the body with
// a warning line (placed first so it survives body truncation) and swap the title glyph.
function pendingCard(r: ChunkRecord, d?: ActionRequest): CardBlock {
  const flagged = !!d?.securityFlagged;
  const rule = d?.ruleName ?? "(egress rule)";
  const stageTag = d?.stage && d.stage !== "initial" ? ` · stage \`${d.stage}\`` : "";

  const denials = d ? `${d.hitCount} hit(s), ${d.denialCount} summary(ies)` : "unknown";
  const bodyLines: string[] = [];
  if (flagged && d?.securityNotes) bodyLines.push(`:warning: ${d.securityNotes}`);
  bodyLines.push(endpointLine(d));
  bodyLines.push(`${proposerLabel(d)} · ${denials}`);
  bodyLines.push(`Seen ${iso(r.createdAt)}`);

  return {
    type: "card",
    block_id: `pending_card_${r.chunkId}`,
    title: mrkdwn(truncate(`${flagged ? ":warning:" : ":hourglass_flowing_sand:"} ${rule}`, CARD_TITLE)),
    subtitle: mrkdwn(truncate(`\`${r.sandboxName}\` · workspace \`${r.workspace}\` · \`${r.chunkId}\`${stageTag}`, CARD_SUBTITLE)),
    body: mrkdwn(truncate(bodyLines.join("\n"), CARD_BODY)),
    actions: pendingCardActions(r, d),
  };
}

// The pending queue as a single horizontally-scrolling carousel. Oldest-first (matching the
// legacy list order) and capped at the carousel's 10-card maximum; `shown` lets the caller add
// an overflow note. Only called when there is at least one pending request (carousels require
// a minimum of one card).
function pendingCarousel(
  pending: ChunkRecord[],
  detail: Map<string, ActionRequest>,
): { block: CarouselBlock; shown: number } {
  const listed = pending
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, MAX_CAROUSEL_CARDS);
  return {
    block: { type: "carousel", block_id: "pending_carousel", elements: listed.map((r) => pendingCard(r, detail.get(r.chunkId))) },
    shown: listed.length,
  };
}

// One audit row for a decided chunk. Uses the durable record for provenance and, when still
// cached, the request detail for the rule name (chunk id otherwise).
function historyLine(r: ChunkRecord, d?: ActionRequest): KnownBlock {
  const rule = d?.ruleName ?? `\`${r.chunkId}\``;
  const when = iso(r.decidedAt ?? r.updatedAt);
  const who = r.decidedBy ? `<@${r.decidedBy}>` : (r.decidedByName ?? "unknown");

  if (r.status === "approved") {
    const ver = r.policyVersion ? `    ·    policy v${r.policyVersion}` : "";
    return section(`:white_check_mark: *${rule}*    ·    ${r.sandboxName}    ·    approved by ${who}    ·    ${when}${ver}`);
  }
  if (r.status === "rejected") {
    const reason = r.rejectReason ? `    ·    reason: ${truncate(r.rejectReason, 160)}` : "";
    return section(`:x: *${rule}*    ·    ${r.sandboxName}    ·    rejected by ${who}    ·    ${when}${reason}`);
  }
  // "closed" == decided outside Slack and reconciled on a later poll.
  return section(`:information_source: *${rule}*    ·    ${r.sandboxName}    ·    closed (decided outside Slack)    ·    ${when}`);
}

// A fixed ACTIVITY_DAYS window ending "today" (UTC), one bucket per day, counting decided chunks
// by decision timestamp. `inWindow` is the total approvals+rejections falling inside the window;
// callers use it to suppress a section when it is 0 so a quiet period renders nothing. Feeds the
// Home Analytics approval-rate line and the decisions modal's per-day breakdown.
interface DayBucket {
  key: string; // YYYY-MM-DD
  label: string; // MM-DD
  approved: number;
  rejected: number;
}
function activityWindow(history: ChunkRecord[], now: number): { days: DayBucket[]; inWindow: number } {
  const byDay = new Map<string, { approved: number; rejected: number }>();
  for (const r of history) {
    if (r.status !== "approved" && r.status !== "rejected") continue;
    const key = new Date(r.decidedAt ?? r.updatedAt).toISOString().slice(0, 10);
    const b = byDay.get(key) ?? { approved: 0, rejected: 0 };
    if (r.status === "approved") b.approved += 1;
    else b.rejected += 1;
    byDay.set(key, b);
  }
  const days: DayBucket[] = [];
  let inWindow = 0;
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const key = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    const b = byDay.get(key) ?? { approved: 0, rejected: 0 };
    inWindow += b.approved + b.rejected;
    days.push({ key, label: key.slice(5), approved: b.approved, rejected: b.rejected });
  }
  return { days, inWindow };
}

// The ACTIVITY_DAYS UTC day keys ending "today", oldest-first. Shared by the audit-activity charts
// so they use the same fixed window as the decisions line chart. `key` is "YYYY-MM-DD" (matches the
// summary's keys); `label` is "MM-DD" for the axis.
function windowDays(now: number): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = [];
  for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
    const key = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    out.push({ key, label: key.slice(5) });
  }
  return out;
}

// Map sandbox id -> friendly name using the approval records (ChunkRecord carries both id and
// name). The audit feed carries only the id, so a sandbox never seen on the approval side falls
// back to its raw id; the null-id bucket renders as "unknown sandbox".
function sandboxLabeler(records: ChunkRecord[]): (id: string) => string {
  const nameById = new Map<string, string>();
  for (const r of records) if (r.sandboxId) nameById.set(r.sandboxId, r.sandboxName);
  return (id) => (id === UNKNOWN_SANDBOX ? "unknown sandbox" : (nameById.get(id) ?? id));
}

// The busiest sandboxes by AUDIT activity over the window: the count of captured audit events per
// sandbox from the capture summary, top MAX_SANDBOX_BARS, as a native bar chart. Ids are mapped to
// friendly names via the approval records (with id fallback). Ties break by label for a stable
// order. Returns null when there is no audit activity in the window (or no summary at all).
function sandboxActivityChart(
  audit: AuditSummaryData | undefined,
  records: ChunkRecord[],
  now: number,
): DataVisualizationBlock | null {
  if (!audit) return null;
  const counts = new Map<string, number>();
  for (const { key } of windowDays(now)) {
    const day = audit.days[key];
    if (!day) continue;
    for (const [sandbox, n] of Object.entries(day.bySandbox)) {
      counts.set(sandbox, (counts.get(sandbox) ?? 0) + n);
    }
  }
  if (counts.size === 0) return null;

  // Data-point labels and axis categories are capped at 20 chars by the data_visualization spec; a
  // longer sandbox name would get the whole view rejected (dropping all analytics), so truncate.
  const nameFor = sandboxLabeler(records);
  const labelFor = (id: string) => truncate(nameFor(id), 20);
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || labelFor(a[0]).localeCompare(labelFor(b[0])),
  );
  const top = ranked.slice(0, MAX_SANDBOX_BARS);
  const more = counts.size - top.length;
  return {
    type: "data_visualization",
    block_id: "sandbox_activity",
    title: `Top sandboxes by activity${more > 0 ? ` (top ${top.length} of ${counts.size})` : ""}`,
    chart: {
      type: "bar",
      series: [{ name: "Events", data: top.map(([id, value]) => ({ label: labelFor(id), value })) }],
      axis_config: {
        categories: top.map(([id]) => labelFor(id)),
        x_label: "Sandbox",
        y_label: "Events",
      },
    },
  };
}

// Total captured audit events per day over the window, as a native line chart (one series).
// Returns null when the window has no audit activity so a quiet period never renders a flat-zero
// chart. Counts ALL captured audit events, not just approval decisions.
function auditVolumeLineChart(
  audit: AuditSummaryData | undefined,
  now: number,
): DataVisualizationBlock | null {
  if (!audit) return null;
  const days = windowDays(now).map(({ key, label }) => ({ label, value: audit.days[key]?.total ?? 0 }));
  const total = days.reduce((sum, d) => sum + d.value, 0);
  if (total === 0) return null;
  return {
    type: "data_visualization",
    block_id: "audit_volume",
    title: `Audit activity · last ${ACTIVITY_DAYS} days`,
    chart: {
      type: "line",
      series: [{ name: "Events", data: days }],
      axis_config: { categories: days.map((d) => d.label), x_label: "Day", y_label: "Events" },
    },
  };
}

// The Analytics "Approvals vs rejections" button. Its handler opens buildDecisionsModal(), a text
// breakdown of the decision history that would crowd the Home tab beside the two audit charts (and
// whose chart could not ride a modal anyway, since data_visualization does not render in modals).
function decisionsButton(): AnyBlock {
  return {
    type: "actions",
    block_id: "decisions_actions",
    elements: [
      {
        type: "button",
        action_id: ACTION_VIEW_DECISIONS,
        text: { type: "plain_text", text: ":chart_with_upwards_trend: Approvals vs rejections", emoji: true },
      },
    ],
  } as unknown as AnyBlock;
}

function adminsBlock(config: AppConfig): KnownBlock {
  if (!config.admins.length) {
    return section("*Authorized admins*\n_none configured; every approval action is rejected_");
  }
  const lines = config.admins
    .map((a) => `• <@${a.slack_user_id}>  ·  ${a.role === "super_admin" ? ":key: super admin" : "admin"}`)
    .join("\n");
  return section(`*Authorized admins* (only these users can approve or reject)\n${lines}`);
}

function routingBlock(config: AppConfig): KnownBlock {
  const overrides = Object.entries(config.routing.workspaceChannels)
    .filter(([, ch]) => ch && ch !== config.routing.defaultChannel)
    .map(([ws, ch]) => `\`${ws}\` → <#${ch}>`);
  const lines = [`Default → <#${config.routing.defaultChannel}>`, ...overrides].join("\n");
  return section(`*Approval routing* (where cards are posted)\n${lines}`);
}

// The four lifetime KPIs as a native `table` block: a true four-across tile row (Pending,
// Approved, Rejected, Closed) that replaces the cramped two-column section-`fields` grid. `table`
// is newer than the pinned @slack/types (untyped), so it is built structurally and cast to
// AnyBlock; views.publish validates the shape server-side. Every cell is `raw_text` (documented
// with a `text` property) to sidestep the under-documented `raw_number` cell shape; raw_text does
// NOT expand :shortcodes:, so the labels carry literal unicode emoji.
function kpiTable(pending: number, approved: number, rejected: number, closed: number): AnyBlock {
  const cell = (text: string) => ({ type: "raw_text", text });
  return {
    type: "table",
    block_id: "kpi_table",
    column_settings: [{ is_wrapped: true }, { is_wrapped: true }, { is_wrapped: true }, { is_wrapped: true }],
    rows: [
      [cell("⏳ Pending"), cell("✅ Approved"), cell("❌ Rejected"), cell("ℹ️ Closed (out-of-band)")],
      [cell(String(pending)), cell(String(approved)), cell(String(rejected)), cell(String(closed))],
    ],
  } as unknown as AnyBlock;
}

// The KPI row as a single-line section strip: the guaranteed-renderable fallback used when the
// `table` block is rejected (kpiTable === false) or on the GA-only view (carousel === false).
// Unlike raw_text table cells, section mrkdwn DOES expand :shortcodes: and bolds the counts.
function kpiStrip(pending: number, approved: number, rejected: number, closed: number): KnownBlock {
  return section(
    [
      `:hourglass_flowing_sand:  Pending  *${pending}*`,
      `:white_check_mark:  Approved  *${approved}*`,
      `:x:  Rejected  *${rejected}*`,
      `:information_source:  Closed (out-of-band)  *${closed}*`,
    ].join("        "),
  );
}

// An admin dashboard: a four-across KPI tile row (native `table`), outstanding egress approvals (a
// carousel of action cards), native data_visualization charts (a decisions-over-time line, a daily
// audit-volume line, and a top-sandboxes-by-activity bar), a trimmed audit trail, and the active
// configuration. The modern view uses table/carousel/card/data_visualization blocks (valid on Home
// tabs via views.publish); everything else is GA Block Kit (header/section/context/divider). The
// publish path degrades in independent tiers, each disabling one block the surface may reject:
// `input.charts === false` omits the Analytics section entirely (data_visualization is the block a
// Home surface is most likely to reject, and there is no fallback chart - the tab shows egress
// approvals, Pending approvals, Recent decisions and Configuration with no analytics);
// `input.kpiTable === false` swaps the table for a one-line strip; `input.carousel === false`
// renders the pending queue as a GA section stack. So the Home tab always renders.
export function buildAppHomeView(input: AppHomeInput): View {
  const { records, detail, config } = input;
  const now = input.now ?? Date.now();
  const useCarousel = input.carousel !== false;
  // The KPI `table` is a newer block; it rides only the modern (carousel) view and can be disabled
  // independently so a table rejection degrades to the strip without also losing the carousel.
  const useKpiTable = useCarousel && input.kpiTable !== false;
  // The native data_visualization Analytics section is gated independently of the carousel/table:
  // it is the one block a Home surface is most likely to reject, so a charts rejection drops only
  // analytics (see the publish path's tier ladder) and leaves the carousel and KPI table intact.
  const useCharts = input.charts !== false;
  const pending = records.filter((r) => r.status === "pending");
  const history = records.filter((r) => r.status !== "pending");

  const approvedCount = history.filter((r) => r.status === "approved").length;
  const rejectedCount = history.filter((r) => r.status === "rejected").length;
  const closedCount = history.filter((r) => r.status === "closed").length;

  const blocks: AnyBlock[] = [
    header(":shield: OpenShell egress approvals"),
    section(
      pending.length
        ? `*${pending.length}* request(s) awaiting a decision.`
        : "No pending requests. All caught up. :tada:",
    ),
  ];

  // At-a-glance KPIs: current pending plus the lifetime decision breakdown, rendered as a
  // four-across tile row (native `table`) on the modern view and a one-line strip on the fallback
  // paths.
  blocks.push(
    useKpiTable
      ? kpiTable(pending.length, approvedCount, rejectedCount, closedCount)
      : kpiStrip(pending.length, approvedCount, rejectedCount, closedCount),
  );

  // Per-workspace pending split, shown only when more than one workspace has something waiting
  // (a single-workspace deployment learns nothing from it).
  const byWorkspace = new Map<string, number>();
  for (const r of pending) byWorkspace.set(r.workspace, (byWorkspace.get(r.workspace) ?? 0) + 1);
  if (byWorkspace.size > 1) {
    blocks.push(
      context(`Pending by workspace: ${[...byWorkspace.entries()].map(([ws, n]) => `\`${ws}\` ${n}`).join("   ·   ")}`),
    );
  }

  // --- Pending approvals ---------------------------------------------------
  blocks.push({ type: "divider" }, header(":inbox_tray: Pending approvals"));
  if (!pending.length) {
    blocks.push(section("Nothing awaiting a decision right now."));
  } else if (useCarousel) {
    // Modern path: one carousel of action cards. A carousel is a single block regardless of how
    // many cards it holds, so the queue costs one block against the 100-block ceiling.
    const { block, shown } = pendingCarousel(pending, detail);
    blocks.push(block);
    if (pending.length > shown) {
      blocks.push(context(`…and ${pending.length - shown} more pending, not shown (the carousel holds the ${shown} oldest).`));
    }
  } else {
    // GA-only fallback: the legacy section + context stack, one group per request.
    const listed = pending.slice().sort((a, b) => a.createdAt - b.createdAt).slice(0, MAX_PENDING);
    for (const r of listed) {
      // Leave room for trailing regions before the hard 100-block ceiling.
      if (blocks.length >= MAX_BLOCKS - 12) break;
      for (const b of pendingBlocks(r, detail.get(r.chunkId))) blocks.push(b);
    }
    if (pending.length > listed.length) {
      blocks.push(context(`…and ${pending.length - listed.length} more pending, not shown.`));
    }
  }

  // --- Analytics -----------------------------------------------------------
  // Native data_visualization charts, capped at 2 per view by the Block Kit spec: the daily
  // audit-activity volume line and the top-sandboxes-by-activity bar (both fed by the capture
  // summary, input.audit). The approvals-vs-rejections detail does NOT render inline — a third chart
  // would exceed the 2-block limit and get the entire view rejected — so it lives in a modal reached
  // via a button here, which presents the decision history as text (data_visualization does not
  // render in modal views, only in messages and Home tabs). This whole region is
  // built from a block the Home surface may reject, so when `charts === false` (the publish path's
  // charts-dropped tier) the section is omitted rather than swapped for a fallback. The section
  // renders when EITHER audit chart has data OR there are in-window decisions to offer the modal
  // for — so audit activity shows even before the first decision, and a fully quiet period renders
  // nothing.
  if (useCharts) {
    const auditVolume = auditVolumeLineChart(input.audit, now);
    const sandboxes = sandboxActivityChart(input.audit, records, now);
    const window = activityWindow(history, now);
    if (auditVolume || sandboxes || window.inWindow > 0) {
      blocks.push({ type: "divider" }, header(":bar_chart: Analytics"));
      if (auditVolume) blocks.push(auditVolume);
      if (sandboxes) blocks.push(sandboxes);
      if (window.inWindow > 0) blocks.push(decisionsButton());
      // The approval-rate figures are computed over the SAME window the charts plot (not lifetime),
      // so the "last N days" descriptor and the numbers describe one period. Lifetime totals live in
      // the KPI table above and the decisions modal.
      const wApproved = window.days.reduce((sum, d) => sum + d.approved, 0);
      const wRejected = window.days.reduce((sum, d) => sum + d.rejected, 0);
      const parts = [`Window: last ${ACTIVITY_DAYS} days`];
      if (wApproved + wRejected > 0) {
        const rate = Math.round((wApproved / (wApproved + wRejected)) * 100);
        parts.push(`approval rate *${rate}%* (${wApproved} approved / ${wRejected} rejected)`);
      }
      if (auditVolume || sandboxes) parts.push("charts render natively");
      blocks.push(context(parts.join("   ·   ")));
    }
  }

  // --- Recent decisions (audit trail) --------------------------------------
  blocks.push({ type: "divider" }, header(":scroll: Recent decisions"));
  if (!history.length) {
    blocks.push(section("No decisions recorded yet."));
  } else {
    const ordered = history
      .slice()
      .sort((a, b) => (b.decidedAt ?? b.updatedAt) - (a.decidedAt ?? a.updatedAt));
    const shown = ordered.slice(0, MAX_RECENT_DECISIONS);
    for (const r of shown) {
      if (blocks.length >= MAX_BLOCKS - 6) break;
      blocks.push(historyLine(r, detail.get(r.chunkId)));
    }
    const note =
      ordered.length > shown.length
        ? `Showing the ${shown.length} most recent of ${ordered.length} decisions. Full history is retained in the bridge state file.`
        : `${ordered.length} decision(s) on record. Full history is retained in the bridge state file.`;
    blocks.push(context(note));
  }

  // --- Configuration -------------------------------------------------------
  blocks.push({ type: "divider" }, header(":gear: Configuration"));
  blocks.push(adminsBlock(config), routingBlock(config));

  return { type: "home", blocks: blocks.slice(0, MAX_BLOCKS) };
}

export interface DecisionsModalInput {
  records: ChunkRecord[];
  // Per-chunk detail for rule names, security flags and proposer type; optional (absent after a
  // restart), and each read tolerates a miss, exactly like the Home audit trail.
  detail?: Map<string, ActionRequest>;
  now?: number;
}

// A compact, human-readable duration for the decision-latency stats: seconds under a minute, then
// minutes, then "Xh Ym", then "Xd Yh". Input is a non-negative epoch-ms delta.
function humanDuration(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
}

// Approved/rejected tallies grouped by some key (reviewer, sandbox, rule), rendered one line per
// group ("<key>    ·    ✅ N   ❌ M"), busiest first, capped at MODAL_BREAKDOWN_ROWS with an
// overflow note. `keyOf` returns the display label for a record, or null to skip it (e.g. a rule
// whose cached detail is gone after a restart). Returns [] when nothing tallies, so the caller can
// omit the whole subsection. `decisions` must already be filtered to approved/rejected records.
function breakdownLines(
  decisions: ChunkRecord[],
  keyOf: (r: ChunkRecord) => string | null,
): string[] {
  const tally = new Map<string, { approved: number; rejected: number }>();
  for (const r of decisions) {
    const key = keyOf(r);
    if (key === null) continue;
    const t = tally.get(key) ?? { approved: 0, rejected: 0 };
    if (r.status === "approved") t.approved += 1;
    else t.rejected += 1;
    tally.set(key, t);
  }
  const ranked = [...tally.entries()].sort(
    (a, b) => (b[1].approved + b[1].rejected) - (a[1].approved + a[1].rejected) || a[0].localeCompare(b[0]),
  );
  const lines = ranked.slice(0, MODAL_BREAKDOWN_ROWS).map(([key, t]) => {
    const counts = [t.approved ? `:white_check_mark: ${t.approved}` : null, t.rejected ? `:x: ${t.rejected}` : null]
      .filter(Boolean)
      .join("   ");
    return `${key}    ·    ${counts}`;
  });
  if (ranked.length > MODAL_BREAKDOWN_ROWS) lines.push(`_…and ${ranked.length - MODAL_BREAKDOWN_ROWS} more_`);
  return lines;
}

// The "Approvals vs rejections" modal opened from the Home Analytics button. data_visualization
// charts do NOT render in modal views (only in messages and on Home tabs), so this modal carries no
// chart; instead it packs the decision history into text a clicking admin actually wants: lifetime
// and windowed counts, a per-day breakdown, time-to-decision stats, breakdowns by reviewer /
// sandbox / rule, a provenance note, and a fuller recent-decisions trail. Every block is GA Block
// Kit (header/section/context/divider), so the modal always opens - no chart to be rejected. A
// separate view from the Home tab, built only when the button is clicked.
export function buildDecisionsModal(input: DecisionsModalInput): View {
  const now = input.now ?? Date.now();
  const detail = input.detail ?? new Map<string, ActionRequest>();
  const history = input.records.filter((r) => r.status !== "pending");
  const pending = input.records.length - history.length;
  const approved = history.filter((r) => r.status === "approved").length;
  const rejected = history.filter((r) => r.status === "rejected").length;
  const closed = history.filter((r) => r.status === "closed").length;
  const decided = approved + rejected;
  // Breakdowns and timing cover only in-Slack decisions; "closed" was decided out-of-band, so it
  // has no reviewer or approve/reject outcome (it still shows in the counts and the trail).
  const decisions = history.filter((r) => r.status === "approved" || r.status === "rejected");
  const blocks: AnyBlock[] = [];

  // Lifetime headline + a context line with the surrounding counts.
  const rate = decided ? Math.round((approved / decided) * 100) : 0;
  blocks.push(
    section(
      decided
        ? `*${approved}* approved  ·  *${rejected}* rejected  ·  approval rate *${rate}%* (lifetime)`
        : "No approvals or rejections recorded yet.",
    ),
  );
  blocks.push(
    context(
      `:hourglass_flowing_sand: ${pending} pending    ·    :information_source: ${closed} closed out-of-band    ·    ${decided} decided in Slack`,
    ),
  );

  // Last-N-days window: counts + a per-day breakdown so the recent trend is legible without a chart.
  const { days, inWindow } = activityWindow(history, now);
  blocks.push({ type: "divider" }, header(`:calendar: Last ${ACTIVITY_DAYS} days`));
  if (inWindow > 0) {
    const wApproved = days.reduce((s, d) => s + d.approved, 0);
    const wRejected = days.reduce((s, d) => s + d.rejected, 0);
    const wRate = wApproved + wRejected ? Math.round((wApproved / (wApproved + wRejected)) * 100) : 0;
    blocks.push(section(`*${wApproved}* approved  ·  *${wRejected}* rejected  ·  approval rate *${wRate}%*`));
    const dayLines = days
      .filter((d) => d.approved + d.rejected > 0)
      .map((d) => {
        const counts = [d.approved ? `:white_check_mark: ${d.approved}` : null, d.rejected ? `:x: ${d.rejected}` : null]
          .filter(Boolean)
          .join("   ");
        return `\`${d.label}\`    ${counts}`;
      });
    blocks.push(section(dayLines.join("\n")));
  } else {
    blocks.push(section(`No approval decisions in the last ${ACTIVITY_DAYS} days.`));
  }

  // Time to decision (createdAt -> decidedAt) over in-Slack decisions with a sane recorded interval.
  const latencies = decisions
    .filter((r) => r.decidedAt != null && r.decidedAt >= r.createdAt)
    .map((r) => r.decidedAt! - r.createdAt)
    .sort((a, b) => a - b);
  if (latencies.length) {
    const total = latencies.reduce((s, ms) => s + ms, 0);
    const median = latencies[Math.floor((latencies.length - 1) / 2)];
    blocks.push({ type: "divider" }, header(":stopwatch: Time to decision"));
    blocks.push(
      section(
        `median *${humanDuration(median)}*    ·    average *${humanDuration(total / latencies.length)}*    ·    fastest *${humanDuration(latencies[0])}*    ·    slowest *${humanDuration(latencies[latencies.length - 1])}*`,
      ),
    );
    blocks.push(context(`Across ${latencies.length} in-Slack decision(s) with a recorded request time.`));
  }

  // Breakdowns: who decided, which sandboxes, which rules (rule name needs cached detail).
  const reviewerLines = breakdownLines(decisions, (r) =>
    r.decidedBy ? `<@${r.decidedBy}>` : r.decidedByName ? r.decidedByName : null,
  );
  if (reviewerLines.length) {
    blocks.push({ type: "divider" }, header(":bust_in_silhouette: By reviewer"));
    blocks.push(section(reviewerLines.join("\n")));
  }

  const sandboxLines = breakdownLines(decisions, (r) => `\`${truncate(r.sandboxName, 40)}\``);
  if (sandboxLines.length) {
    blocks.push({ type: "divider" }, header(":package: By sandbox"));
    blocks.push(section(sandboxLines.join("\n")));
  }

  const ruleLines = breakdownLines(decisions, (r) => {
    const name = detail.get(r.chunkId)?.ruleName;
    return name ? `\`${truncate(name, 40)}\`` : null;
  });
  if (ruleLines.length) {
    blocks.push({ type: "divider" }, header(":scroll: By rule"));
    blocks.push(section(ruleLines.join("\n")));
  }

  // Provenance from cached detail (absent for pre-restart decisions): security flags + proposer mix.
  const withDetail = decisions.map((r) => detail.get(r.chunkId)).filter((d): d is ActionRequest => !!d);
  if (withDetail.length) {
    const flagged = withDetail.filter((d) => d.securityFlagged).length;
    const mechanistic = withDetail.filter((d) => d.proposerType === "mechanistic").length;
    blocks.push(
      context(
        `:lock: ${flagged} security-flagged    ·    ${mechanistic} mechanistic / ${withDetail.length - mechanistic} agent-authored    ·    detail cached for ${withDetail.length} of ${decisions.length} decision(s)`,
      ),
    );
  }

  // Recent decisions trail (rich lines with rejection reasons + provenance), newest first.
  const ordered = history.slice().sort((a, b) => (b.decidedAt ?? b.updatedAt) - (a.decidedAt ?? a.updatedAt));
  if (ordered.length) {
    blocks.push({ type: "divider" }, header(":clipboard: Recent decisions"));
    for (const r of ordered.slice(0, MAX_MODAL_DECISIONS)) {
      if (blocks.length >= MAX_BLOCKS - 2) break;
      blocks.push(historyLine(r, detail.get(r.chunkId)));
    }
    if (ordered.length > MAX_MODAL_DECISIONS) {
      blocks.push(context(`Showing the ${MAX_MODAL_DECISIONS} most recent of ${ordered.length} decisions.`));
    }
  }

  return {
    type: "modal",
    callback_id: DECISIONS_MODAL_CALLBACK,
    title: { type: "plain_text", text: "Approvals vs rejections" },
    close: { type: "plain_text", text: "Close" },
    blocks: blocks.slice(0, MAX_BLOCKS),
  } as View;
}
