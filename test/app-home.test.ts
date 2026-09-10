import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KnownBlock, CardBlock, CarouselBlock } from "@slack/types";
import { buildAppHomeView, buildDecisionsModal } from "../src/app-home";
import { ACTION_APPROVE, ACTION_REJECT, ACTION_OPEN_REQUEST, ACTION_VIEW_DECISIONS } from "../src/slack-messages";
import type { ChunkRecord } from "../src/state-store";
import type { ActionRequest } from "../src/action-request";
import type { AppConfig, OpenShellAuth } from "../src/config";
import type { AuditSummaryData } from "../src/audit-summary";
import { DecisionService } from "../src/decision-service";

const insecureAuth: OpenShellAuth = { mode: "mtls", useTls: false };

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    openshell: { gatewayUrl: "127.0.0.1:17670", auth: insecureAuth },
    admins: [
      { slack_user_id: "U_SUPER", name: "Ada Admin", role: "super_admin" },
      { slack_user_id: "U_ADMIN", name: "Bo Admin", role: "admin" },
    ],
    routing: { defaultChannel: "C_APPROVALS", workspaceChannels: { default: "C_APPROVALS", prod: "C_PROD" } },
    settings: { rejectReasonRequired: true, destructiveRoles: ["super_admin"] },
    defaultWorkspace: "default",
    pollIntervalMs: 3000,
    pollConcurrency: 25,
    watchMode: "off",
    // summaryStatePath points at a path that never exists so readAuditSummary (used by the
    // DecisionService.homeViewFor test) returns null; chart tests pass `audit` to buildAppHomeView
    // directly rather than through a file.
    capture: { sources: [], excludeEventTypes: [], summaryStatePath: "/nonexistent/audit-summary.json" },
    statePath: "/tmp/does-not-matter.json",
    logLevel: "info",
    ...overrides,
  };
}

// Build an AuditSummaryData from a terse { "YYYY-MM-DD": { bySandbox } } literal; the per-day total
// is derived from the sandbox counts, mirroring what AuditSummaryStore writes.
function auditSummary(days: Record<string, { bySandbox?: Record<string, number>; bySeverity?: Record<string, number> }>): AuditSummaryData {
  const out: AuditSummaryData = { version: 1, updatedAt: 0, days: {} };
  for (const [key, d] of Object.entries(days)) {
    const bySandbox = d.bySandbox ?? {};
    const total = Object.values(bySandbox).reduce((a, b) => a + b, 0);
    out.days[key] = { total, bySandbox, bySeverity: d.bySeverity ?? {} };
  }
  return out;
}

function pendingRecord(id: string, createdAt: number, over: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    chunkId: id,
    sandboxId: `sbx-${id}`,
    sandboxName: "web-agent",
    workspace: "default",
    channelId: "C_APPROVALS",
    status: "pending",
    createdAt,
    updatedAt: createdAt,
    ...over,
  };
}

function decidedRecord(id: string, status: "approved" | "rejected" | "closed", decidedAt: number, over: Partial<ChunkRecord> = {}): ChunkRecord {
  return {
    chunkId: id,
    sandboxId: `sbx-${id}`,
    sandboxName: "web-agent",
    workspace: "default",
    status,
    createdAt: decidedAt - 1000,
    updatedAt: decidedAt,
    decidedAt,
    ...over,
  };
}

function detailFor(id: string, over: Partial<ActionRequest> = {}): ActionRequest {
  return {
    kind: "network",
    chunkId: id,
    status: "pending",
    stage: "initial",
    sandboxId: `sbx-${id}`,
    sandboxName: "web-agent",
    workspace: "default",
    reviewToken: "rt",
    ruleName: `rule-${id}`,
    endpoints: [{ host: "files.pythonhosted.org", ports: "443", protocol: "tcp", l7: "" }],
    binaries: ["/usr/bin/pip"],
    rationale: "",
    securityNotes: "",
    validationResult: "",
    confidence: 0,
    proposerType: "mechanistic",
    securityFlagged: false,
    hitCount: 3,
    denialCount: 2,
    ...over,
  };
}

// A card's visible text: title / subtitle / body plus each action button's label and (for the
// Open-request deep link) its url, so assertions can reach content that now lives on cards.
function cardText(card: CardBlock): string {
  const c = card as {
    title?: { text?: string };
    subtitle?: { text?: string };
    body?: { text?: string };
    actions?: { text?: { text?: string }; url?: string }[];
  };
  const parts: (string | undefined)[] = [c.title?.text, c.subtitle?.text, c.body?.text];
  for (const a of c.actions ?? []) {
    parts.push(a.text?.text);
    if (a.url) parts.push(a.url);
  }
  return parts.filter(Boolean).join(" ");
}

// Flatten a block's user-visible text: section text, section `fields`, context elements, and
// (for a carousel) every card's title/subtitle/body/button text. Field text keeps its internal
// "\n" so KPI tiles can be matched as "<label>\n<count>".
function blockText(b: KnownBlock): string {
  const anyB = b as {
    type?: string;
    text?: { text?: string };
    fields?: { text?: string }[];
    elements?: ({ text?: string } | CardBlock)[];
    rows?: { text?: string }[][];
  };
  const parts: string[] = [];
  if (anyB.text?.text) parts.push(anyB.text.text);
  if (anyB.fields) parts.push(...anyB.fields.map((f) => f.text ?? ""));
  if (anyB.type === "table") {
    for (const row of anyB.rows ?? []) parts.push(...row.map((c) => c.text ?? ""));
  } else if (anyB.type === "carousel") {
    for (const card of (anyB.elements ?? []) as CardBlock[]) parts.push(cardText(card));
  } else if (anyB.elements) {
    parts.push(...(anyB.elements as { text?: string }[]).map((e) => e.text ?? ""));
  }
  return parts.join(" ");
}

// The KPI `table` (modern view) as { labels, counts } rows, or undefined on the strip/fallback
// paths (kpiTable:false or carousel:false), which render the KPIs as a one-line section instead.
function kpiTableOf(blocks: KnownBlock[]): { labels: string[]; counts: string[] } | undefined {
  const t = blocks.find((b) => (b as { type?: string }).type === "table") as { rows?: { text?: string }[][] } | undefined;
  if (!t?.rows) return undefined;
  return { labels: t.rows[0].map((c) => c.text ?? ""), counts: t.rows[1].map((c) => c.text ?? "") };
}

function allText(blocks: KnownBlock[]): string {
  return blocks.map(blockText).join("\n");
}

// The pending carousel, if the view rendered one (the modern path). Undefined in the GA fallback.
function carouselOf(blocks: KnownBlock[]): CarouselBlock | undefined {
  return blocks.find((b) => (b as { type?: string }).type === "carousel") as CarouselBlock | undefined;
}

// Native chart (data_visualization) blocks in the view. data_visualization is newer than the
// pinned @slack/types, so it is not a KnownBlock; reach it structurally.
interface VizBlock {
  type: "data_visualization";
  title?: string;
  chart: {
    type: "line" | "bar";
    series: { name: string; data: { label: string; value: number }[] }[];
    axis_config?: { categories?: string[]; x_label?: string; y_label?: string };
  };
}
function dataViz(blocks: KnownBlock[]): VizBlock[] {
  return (blocks as unknown as { type?: string }[]).filter((b) => b.type === "data_visualization") as unknown as VizBlock[];
}

// The Analytics "Approvals vs rejections" button (an actions block, block_id "decisions_actions")
// that opens the decisions modal, or undefined when the Analytics section omits it. The button
// label is an object rather than a string, so match it structurally rather than via allText.
function decisionsButtonOf(blocks: KnownBlock[]): { action_id?: string } | undefined {
  const actions = blocks.find(
    (b) => (b as { block_id?: string }).block_id === "decisions_actions",
  ) as { elements?: { action_id?: string }[] } | undefined;
  return actions?.elements?.[0];
}

const DAY = 24 * 60 * 60 * 1000;

test("admin view renders pending detail, KPI table, audit history, admins and routing", () => {
  const detail = new Map<string, ActionRequest>();
  detail.set("chunk-p1", detailFor("chunk-p1", { ruleName: "allow-pypi", confidence: 0, proposerType: "mechanistic" }));
  detail.set("chunk-p2", detailFor("chunk-p2", {
    ruleName: "allow-weights",
    confidence: 0.82,
    proposerType: "agent_authored",
    securityFlagged: true,
    securityNotes: "Uncategorized host; verify before approving.",
    endpoints: [{ host: "weights.example.net", ports: "443", protocol: "tcp", l7: "GET /models/*" }],
  }));
  detail.set("chunk-a1", detailFor("chunk-a1", { ruleName: "allow-old", status: "approved" }));

  const day = 24 * 60 * 60 * 1000;
  const t0 = 1_735_689_600_000; // 2025-01-01T00:00:00Z; fixed reference for deterministic timestamps
  const records: ChunkRecord[] = [
    pendingRecord("chunk-p1", t0 + 100, { permalink: "https://acme.slack.com/archives/C_APPROVALS/p1735689600000100" }),
    pendingRecord("chunk-p2", t0 + 200),
    // chunk-a1 is the oldest decision (day 1); the audit trail trims to the 3 most recent, so it
    // is the one that drops off, leaving one approval, one rejection and one closure on show.
    decidedRecord("chunk-a1", "approved", t0 + day, { decidedBy: "U_SUPER", policyVersion: 7, sandboxName: "db-agent" }),
    decidedRecord("chunk-r1", "rejected", t0 + 2 * day, { decidedBy: "U_ADMIN", rejectReason: "not a trusted mirror" }),
    decidedRecord("chunk-a2", "approved", t0 + 2 * day, { decidedBy: "U_SUPER", policyVersion: 8, sandboxName: "batch-agent" }),
    decidedRecord("chunk-c1", "closed", t0 + 2 * day, { sandboxName: "db-agent" }),
  ];

  // Audit activity from the capture summary, keyed by sandbox id; the charts join id -> friendly
  // name via the records above (sbx-chunk-a1 -> db-agent, sbx-chunk-a2 -> batch-agent) and bucket
  // the null-id events under "unknown sandbox".
  const audit = auditSummary({
    "2025-01-03": { bySandbox: { "sbx-chunk-a1": 5, "sbx-chunk-a2": 3, unknown: 1 } }, // t0+2day
    "2025-01-04": { bySandbox: { "sbx-chunk-a1": 2 } }, // t0+3day (now)
  });

  // "now" anchors the relative timestamps and the activity window the charts plot.
  const view = buildAppHomeView({ records, detail, config: makeConfig(), now: t0 + 3 * day, audit });
  assert.equal(view.type, "home");
  const blocks = view.blocks as KnownBlock[];
  const text = allText(blocks);

  // Pending cards: rule names, endpoints, proposer labels, and the security warning all land in
  // the carousel card title/subtitle/body.
  assert.match(text, /allow-pypi/);
  assert.match(text, /mechanistic \(deterministic\)/);
  assert.match(text, /allow-weights/);
  assert.match(text, /agent-authored \(82% confidence\)/);
  assert.match(text, /weights\.example\.net/);
  assert.match(text, /Uncategorized host/); // flagged card leads its body with the security note

  // chunk-p1 has a permalink, so its card carries an "Open request" url button (chunk-p2 has none).
  assert.match(text, /Open request/);
  assert.match(text, /https:\/\/acme\.slack\.com\/archives\/C_APPROVALS\/p1735689600000100/);

  // Lifetime totals now live in the four-across KPI `table`: a labels row and an aligned counts row.
  const kpi = kpiTableOf(blocks);
  assert.ok(kpi, "KPI table rendered on the modern view");
  assert.deepEqual(kpi!.labels, ["⏳ Pending", "✅ Approved", "❌ Rejected", "ℹ️ Closed (out-of-band)"]);
  assert.deepEqual(kpi!.counts, ["2", "2", "1", "1"]);

  // Audit rows: approver mentions, policy version, reject reason, out-of-band closure.
  assert.match(text, /approved by <@U_SUPER>.*policy v8/);
  assert.match(text, /rejected by <@U_ADMIN>.*reason: not a trusted mirror/);
  assert.match(text, /closed \(decided outside Slack\)/);

  // Analytics: the Home tab renders exactly the two audit-fed data_visualization charts (the daily
  // audit-volume line and the top-sandboxes-by-activity bar) - the 2-chart-per-view cap - plus a
  // button that opens the approvals-vs-rejections modal. The decisions line lives in that modal, not
  // inline, because a third chart would exceed the limit and get the whole view rejected.
  const charts = dataViz(blocks);
  assert.equal(charts.length, 2, "audit-volume line + activity bar only (decisions line moved to the modal)");
  assert.ok(!charts.some((c) => c.chart.series.some((s) => s.name === "Approved")), "no decisions line on the Home tab");
  assert.equal(decisionsButtonOf(blocks)?.action_id, ACTION_VIEW_DECISIONS, "Analytics button opens the decisions modal");
  const volume = charts.find((c) => (c.title ?? "").startsWith("Audit activity"))!;
  const bar = charts.find((c) => c.chart.type === "bar")!;

  // The audit-volume line totals every captured event per day over the same 10-day window.
  assert.ok(volume, "daily audit-volume line chart present");
  assert.equal(volume.chart.type, "line");
  assert.equal(volume.chart.axis_config!.categories!.length, 10);
  const vol = (label: string) => volume.chart.series[0].data.find((d) => d.label === label)?.value;
  assert.equal(vol("01-03"), 9); // 5 + 3 + 1
  assert.equal(vol("01-04"), 2);

  // The bar chart ranks sandboxes by AUDIT activity over the window, descending, mapping the
  // summary's sandbox ids to friendly names (unknown ids -> "unknown sandbox").
  assert.match(bar.title!, /Top sandboxes by activity/);
  assert.equal(bar.chart.axis_config!.y_label, "Events");
  assert.deepEqual(
    bar.chart.series[0].data.map((d) => [d.label, d.value]),
    [
      ["db-agent", 7], // sbx-chunk-a1: 5 + 2
      ["batch-agent", 3], // sbx-chunk-a2
      ["unknown sandbox", 1], // null-id bucket
    ],
  );

  // Configuration: admins (as clickable mentions) and routing channel(s).
  assert.match(text, /<@U_SUPER>/);
  assert.match(text, /super admin/);
  assert.match(text, /<#C_APPROVALS>/);
  assert.match(text, /prod.*<#C_PROD>/);

  assert.ok(blocks.length <= 100, "under the 100-block ceiling");
});

test("empty state renders the caught-up and no-decisions notices without a chart", () => {
  const view = buildAppHomeView({ records: [], detail: new Map(), config: makeConfig() });
  const text = allText(view.blocks as KnownBlock[]);
  assert.match(text, /All caught up/);
  assert.match(text, /No decisions recorded yet/);
  assert.doesNotMatch(text, /:bar_chart:/); // no Activity header when there is no history
});

test("decisions modal pins a fixed 10-day window: the per-day breakdown excludes older decisions", () => {
  const t0 = 1_735_689_600_000; // 2025-01-01T00:00:00Z
  const now = t0 + 20 * DAY; // 2025-01-21; window is 01-12 .. 01-21
  const records: ChunkRecord[] = [
    decidedRecord("in-window", "approved", now - 2 * DAY, { decidedBy: "U_SUPER" }), // 01-19, inside
    decidedRecord("too-old", "approved", now - 15 * DAY, { decidedBy: "U_SUPER" }), // 01-06, outside
  ];
  const blocks = buildDecisionsModal({ records, detail: new Map(), now }).blocks as KnownBlock[];
  const text = allText(blocks);
  assert.equal(dataViz(blocks).length, 0, "modals carry no data_visualization chart");
  // Lifetime counts both approvals; the windowed section and per-day breakdown count only the one
  // inside the fixed 10-day window. A change to the window (constant edited, filter dropped) breaks this.
  assert.match(text, /\*2\* approved.*\(lifetime\)/);
  const inLabel = new Date(now - 2 * DAY).toISOString().slice(5, 10); // 01-19
  const oldLabel = new Date(now - 15 * DAY).toISOString().slice(5, 10); // 01-06
  assert.match(text, new RegExp(`\`${inLabel}\``)); // the in-window day appears in the breakdown (backtick-wrapped)
  assert.doesNotMatch(text, new RegExp(`\`${oldLabel}\``)); // the older decision is outside the window
});

test("activity older than the window hides the chart instead of an all-quiet grid", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 30 * DAY;
  const records: ChunkRecord[] = [decidedRecord("old", "approved", now - 20 * DAY, { decidedBy: "U_SUPER" })];
  const view = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now });
  assert.doesNotMatch(allText(view.blocks as KnownBlock[]), /:bar_chart:/);
});

test("history of only closed (out-of-band) decisions hides the chart but still counts in the KPI totals", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 2 * DAY;
  const records: ChunkRecord[] = [decidedRecord("c1", "closed", now - 60_000)];
  const blocks = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now }).blocks as KnownBlock[];
  assert.equal(dataViz(blocks).length, 0, "closures are not approvals/rejections, so nothing to plot");
  assert.doesNotMatch(allText(blocks), /:bar_chart:/);
  assert.deepEqual(kpiTableOf(blocks)!.counts, ["0", "0", "0", "1"]); // the out-of-band closure counts in the KPI totals
});

test("pending card with no channel yet shows the not-posted-to-a-channel fallback (GA path)", () => {
  // The "not yet posted" hint is a GA-fallback affordance; a carousel card simply omits its Open
  // button until a permalink exists, so this behavior is exercised on the fallback view.
  const records: ChunkRecord[] = [pendingRecord("chunk-np", 1000, { channelId: undefined })];
  const text = allText(buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now: 2000, carousel: false }).blocks as KnownBlock[]);
  assert.match(text, /not yet posted to a channel/);
});

test("missing request detail falls back gracefully (post-restart history rows)", () => {
  const t0 = 1_735_689_600_000;
  const records: ChunkRecord[] = [
    pendingRecord("chunk-p9", t0),
    decidedRecord("chunk-a9", "approved", t0 + 1000, { decidedByName: "Cy Admin", policyVersion: 3 }),
  ];
  // No detail cache entries (as after a restart, where only pending chunks get refilled).
  const view = buildAppHomeView({ records, detail: new Map(), config: makeConfig() });
  const text = allText(view.blocks as KnownBlock[]);
  assert.match(text, /\(egress rule\)/); // pending fallback title
  assert.match(text, /endpoints unavailable/);
  assert.match(text, /chunk-a9/); // history falls back to the chunk id as the label
  assert.match(text, /approved by Cy Admin/); // name used when no decidedBy id present
});

test("stale pending detail cap: only MAX_PENDING shown with an overflow note", () => {
  const records: ChunkRecord[] = [];
  for (let i = 0; i < 25; i++) records.push(pendingRecord(`chunk-${i}`, 1000 + i));
  const view = buildAppHomeView({ records, detail: new Map(), config: makeConfig() });
  const blocks = view.blocks as KnownBlock[];
  const text = allText(blocks);
  const carousel = carouselOf(blocks);
  assert.ok(carousel, "pending rendered as a carousel");
  assert.equal(carousel!.elements.length, 10, "carousel capped at MAX_CAROUSEL_CARDS");
  assert.match(text, /and \d+ more pending, not shown/);
  assert.ok(blocks.length <= 100);
});

test("pending queue renders as a carousel of action cards wired to the existing handlers", () => {
  const detail = new Map<string, ActionRequest>();
  detail.set("chunk-p1", detailFor("chunk-p1", { ruleName: "allow-pypi" }));
  const records: ChunkRecord[] = [
    pendingRecord("chunk-p1", 1000, { permalink: "https://acme.slack.com/archives/C_APPROVALS/p1" }),
    pendingRecord("chunk-p2", 2000), // no permalink
  ];
  const view = buildAppHomeView({ records, detail, config: makeConfig(), now: 3000 });
  const carousel = carouselOf(view.blocks as KnownBlock[]);
  assert.ok(carousel, "pending queue is a carousel block");
  assert.equal(carousel!.elements.length, 2);
  for (const card of carousel!.elements as CardBlock[]) assert.equal(card.type, "card");

  // Oldest-first ordering (matching the legacy list order); block_id carries the chunk id.
  const withLink = carousel!.elements[0] as CardBlock;
  const noLink = carousel!.elements[1] as CardBlock;
  assert.match(withLink.block_id!, /chunk-p1/);

  // The permalinked card carries all three buttons; the one without omits Open request.
  const actionIds = (c: CardBlock) => (c.actions ?? []).map((a) => a.action_id);
  assert.deepEqual(actionIds(withLink), [ACTION_APPROVE, ACTION_REJECT, ACTION_OPEN_REQUEST]);
  assert.deepEqual(actionIds(noLink), [ACTION_APPROVE, ACTION_REJECT]);

  // Approve/Reject reuse the channel-message contract: `value` carries the chunk id so the
  // existing Bolt handlers fire from the Home tab unchanged; Approve keeps its confirm dialog.
  const approve = withLink.actions!.find((a) => a.action_id === ACTION_APPROVE)!;
  const reject = withLink.actions!.find((a) => a.action_id === ACTION_REJECT)!;
  const open = withLink.actions!.find((a) => a.action_id === ACTION_OPEN_REQUEST)!;
  assert.equal(approve.value, "chunk-p1");
  assert.equal(approve.style, "primary");
  assert.ok(approve.confirm, "Approve keeps a confirm dialog on the Home tab");
  assert.equal(reject.value, "chunk-p1");
  assert.equal(reject.style, "danger");
  assert.equal(open.url, "https://acme.slack.com/archives/C_APPROVALS/p1");
});

test("carousel:false renders the GA-only fallback (no carousel; legacy section/context stack)", () => {
  const detail = new Map<string, ActionRequest>();
  detail.set("chunk-p2", detailFor("chunk-p2", {
    ruleName: "allow-weights",
    confidence: 0.82,
    proposerType: "agent_authored",
    securityFlagged: true,
    securityNotes: "Uncategorized host; verify before approving.",
    endpoints: [{ host: "weights.example.net", ports: "443", protocol: "tcp", l7: "" }],
  }));
  const records: ChunkRecord[] = [
    pendingRecord("chunk-p1", 1000, { permalink: "https://acme.slack.com/archives/C_APPROVALS/p1" }),
    pendingRecord("chunk-p2", 2000), // no permalink -> plain channel reference
  ];
  const view = buildAppHomeView({ records, detail, config: makeConfig(), now: 3000, carousel: false });
  const blocks = view.blocks as KnownBlock[];
  assert.equal(carouselOf(blocks), undefined, "no carousel block in the GA fallback");
  const text = allText(blocks);
  // Legacy pending rows: proposer label, endpoint, the permalink deep-link (mrkdwn), a plain
  // channel reference for the unlinked one, and the security-notes context.
  assert.match(text, /agent-authored \(82% confidence\)/);
  assert.match(text, /weights\.example\.net/);
  assert.match(text, /<https:\/\/acme\.slack\.com\/archives\/C_APPROVALS\/p1\|:link: open request>/);
  assert.match(text, /posted in <#C_APPROVALS>/);
  assert.match(text, /Security review:.*Uncategorized host/);
});

test("analytics: charts render natively; charts:false omits the Analytics section entirely", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 3 * DAY;
  const records: ChunkRecord[] = [
    decidedRecord("a1", "approved", t0 + DAY, { decidedBy: "U_SUPER", sandboxName: "web-agent" }),
    decidedRecord("r1", "rejected", t0 + DAY, { decidedBy: "U_ADMIN", sandboxName: "db-agent" }),
  ];

  // Charts accepted (the modern default): the Home tab carries NO inline chart here (the two
  // audit-fed charts need a capture summary, absent in this test, and the decisions line lives in
  // the modal), but the Analytics section still renders its header and the approvals-vs-rejections
  // button because there are in-window decisions to open the modal for.
  const withCharts = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now }).blocks as KnownBlock[];
  assert.equal(dataViz(withCharts).length, 0, "no inline charts (audit charts need a summary; decisions line is in the modal)");
  assert.match(allText(withCharts), /:bar_chart:/, "Analytics section header present");
  assert.equal(decisionsButtonOf(withCharts)?.action_id, ACTION_VIEW_DECISIONS, "decisions modal button present");
  assert.doesNotMatch(allText(withCharts), /🟩|🟥/, "no emoji chart anywhere");

  // Charts rejected (charts:false): the Analytics section is dropped wholesale, with no fallback
  // chart of any kind. Egress approvals, Recent decisions and Configuration still render, and the
  // pending carousel is untouched.
  const noCharts = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now, charts: false }).blocks as KnownBlock[];
  assert.equal(dataViz(noCharts).length, 0, "no native charts when charts is false");
  assert.doesNotMatch(allText(noCharts), /🟩|🟥/, "no emoji fallback either");
  assert.doesNotMatch(allText(noCharts), /:bar_chart:|Analytics|Activity \(last/, "no Analytics section at all");
  assert.match(allText(noCharts), /OpenShell egress approvals/, "egress approvals header still present");
  assert.match(allText(noCharts), /Recent decisions/, "Recent decisions still present");
  assert.match(allText(noCharts), /Configuration/, "Configuration still present");
});

test("decisions modal: summary, windowed counts, breakdowns, and the recent-decisions trail (no chart)", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 3 * DAY;
  const detail = new Map<string, ActionRequest>();
  detail.set("a1", detailFor("a1", { ruleName: "allow-pypi" }));
  const records: ChunkRecord[] = [
    pendingRecord("p1", t0), // pending is excluded from the decided breakdowns; still counted as pending
    decidedRecord("a1", "approved", t0 + DAY, { decidedBy: "U_SUPER" }),
    decidedRecord("a2", "approved", t0 + 2 * DAY, { decidedBy: "U_SUPER" }),
    decidedRecord("r1", "rejected", t0 + 2 * DAY, { decidedBy: "U_ADMIN", rejectReason: "untrusted" }),
  ];
  const modal = buildDecisionsModal({ records, detail, now });
  assert.equal(modal.type, "modal");
  const blocks = modal.blocks as KnownBlock[];
  const text = allText(blocks);

  // data_visualization does not render in modal views, so the modal is entirely chartless.
  assert.equal(dataViz(blocks).length, 0, "modals carry no data_visualization chart");

  // Lifetime summary: 2 approved, 1 rejected -> 67%; the surrounding-counts line reports 1 pending.
  assert.match(text, /\*2\* approved.*\*1\* rejected.*approval rate \*67%\* \(lifetime\)/);
  assert.match(text, /1 pending/);

  // Time to decision: every fixture decision is 1s old (createdAt = decidedAt - 1000).
  assert.match(text, /Time to decision/);
  assert.match(text, /median \*1s\*/);

  // Breakdowns by reviewer, sandbox and rule (rule name resolved from the detail cache).
  assert.match(text, /By reviewer/);
  assert.match(text, /<@U_SUPER>/);
  assert.match(text, /<@U_ADMIN>/);
  assert.match(text, /By sandbox/);
  assert.match(text, /By rule/);
  assert.match(text, /allow-pypi/); // a1 resolves its rule name from the detail cache

  // Recent-decisions trail: rule name, approver mention, reject reason.
  assert.match(text, /Recent decisions/);
  assert.match(text, /rejected by <@U_ADMIN>.*reason: untrusted/);
});

test("decisions modal: time-to-decision stats and the by-reviewer / by-sandbox breakdowns", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 2 * DAY;
  const records: ChunkRecord[] = [
    // Two reviewers, two sandboxes, decision latencies of 30 minutes and 2 hours.
    decidedRecord("a1", "approved", t0 + DAY, { decidedBy: "U_SUPER", sandboxName: "web-agent", createdAt: t0 + DAY - 30 * 60_000 }),
    decidedRecord("r1", "rejected", t0 + DAY, { decidedBy: "U_ADMIN", sandboxName: "db-agent", createdAt: t0 + DAY - 2 * 3_600_000 }),
  ];
  const text = allText(buildDecisionsModal({ records, detail: new Map(), now }).blocks as KnownBlock[]);
  assert.match(text, /median \*30m\*/); // lower-middle of the sorted [30m, 2h] latencies
  assert.match(text, /average \*1h 15m\*/); // (30m + 2h) / 2
  assert.match(text, /slowest \*2h\*/);
  assert.match(text, /web-agent/);
  assert.match(text, /db-agent/);
});

test("decisions modal: no in-window decisions shows a no-recent-activity note, still counting lifetime", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 30 * DAY; // the only decision is well before this window
  const records: ChunkRecord[] = [decidedRecord("old", "approved", now - 20 * DAY, { decidedBy: "U_SUPER" })];
  const blocks = buildDecisionsModal({ records, detail: new Map(), now }).blocks as KnownBlock[];
  const text = allText(blocks);
  assert.equal(dataViz(blocks).length, 0);
  assert.match(text, /No approval decisions in the last 10 days\./);
  // The lifetime summary still counts the older approval, and the trail still lists it.
  assert.match(text, /\*1\* approved/);
  assert.match(text, /Recent decisions/);
});

test("decisions modal: empty history shows the no-decisions summary and no chart or trail", () => {
  const blocks = buildDecisionsModal({ records: [], detail: new Map(), now: 1_000_000 }).blocks as KnownBlock[];
  assert.equal(dataViz(blocks).length, 0);
  assert.match(allText(blocks), /No approvals or rejections recorded yet/);
  assert.doesNotMatch(allText(blocks), /Recent decisions/); // no trail when there is no history
});

test("audit charts render from the capture summary and map sandbox ids to friendly names", () => {
  const t0 = 1_735_689_600_000; // 2025-01-01
  const now = t0 + 3 * DAY; // 2025-01-04
  const records: ChunkRecord[] = [
    decidedRecord("a1", "approved", t0 + DAY, { decidedBy: "U_SUPER", sandboxName: "web-agent" }), // sbx-a1
    decidedRecord("a2", "approved", t0 + DAY, { decidedBy: "U_SUPER", sandboxName: "db-agent" }), // sbx-a2
  ];
  const audit = auditSummary({
    "2025-01-03": { bySandbox: { "sbx-a1": 5, "sbx-a2": 2, unknown: 1 } },
    "2025-01-04": { bySandbox: { "sbx-a1": 3 } },
  });
  const charts = dataViz(buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now, audit }).blocks as KnownBlock[]);

  const bar = charts.find((c) => c.chart.type === "bar")!;
  assert.match(bar.title!, /Top sandboxes by activity/);
  assert.equal(bar.chart.axis_config!.y_label, "Events");
  assert.deepEqual(
    bar.chart.series[0].data.map((d) => [d.label, d.value]),
    [
      ["web-agent", 8], // sbx-a1: 5 + 3, joined to its friendly name
      ["db-agent", 2], // sbx-a2
      ["unknown sandbox", 1], // the null-id bucket
    ],
  );

  const volume = charts.find((c) => (c.title ?? "").startsWith("Audit activity"))!;
  assert.ok(volume, "daily audit-volume line chart present");
  const vol = (label: string) => volume.chart.series[0].data.find((d) => d.label === label)?.value;
  assert.equal(vol("01-03"), 8); // 5 + 2 + 1
  assert.equal(vol("01-04"), 3);
});

test("audit activity renders the Analytics section even before any approval decision", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 2 * DAY; // 2025-01-03
  const audit = auditSummary({ "2025-01-02": { bySandbox: { "sbx-x": 4 } } }); // in-window, unseen id
  const records: ChunkRecord[] = [pendingRecord("p1", t0)]; // pending only: no decisions to plot
  const blocks = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now, audit }).blocks as KnownBlock[];
  const text = allText(blocks);

  assert.match(text, /:bar_chart:/); // Analytics section is present despite zero decisions
  const charts = dataViz(blocks);
  assert.ok(!charts.some((c) => c.chart.series.some((s) => s.name === "Approved")), "no decisions line");
  assert.ok(charts.some((c) => (c.title ?? "").startsWith("Audit activity")), "audit volume line present");
  // An unseen sandbox id has no friendly name, so it falls back to the raw id on the bar chart.
  const bar = charts.find((c) => c.chart.type === "bar")!;
  assert.deepEqual(bar.chart.series[0].data.map((d) => d.label), ["sbx-x"]);
  // The context line omits the approval-rate clause when there are no decisions.
  assert.doesNotMatch(text, /approval rate/);
});

test("audit activity older than the window is excluded from the charts", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 30 * DAY; // 2025-01-31; window is 01-22 .. 01-31
  const audit = auditSummary({ "2025-01-02": { bySandbox: { "sbx-x": 9 } } }); // ~29 days old, outside
  const blocks = buildAppHomeView({ records: [], detail: new Map(), config: makeConfig(), now, audit }).blocks as KnownBlock[];
  assert.equal(dataViz(blocks).length, 0, "out-of-window audit activity plots nothing");
  assert.doesNotMatch(allText(blocks), /:bar_chart:/);
});

test("charts:false drops the audit charts along with the whole Analytics section", () => {
  const t0 = 1_735_689_600_000;
  const now = t0 + 2 * DAY;
  const audit = auditSummary({ "2025-01-02": { bySandbox: { "sbx-x": 4 } } });
  const blocks = buildAppHomeView({ records: [], detail: new Map(), config: makeConfig(), now, audit, charts: false }).blocks as KnownBlock[];
  assert.equal(dataViz(blocks).length, 0, "no charts (audit or decisions) when charts is false");
  assert.doesNotMatch(allText(blocks), /:bar_chart:|Analytics/);
});

test("charts:false keeps the carousel and the KPI table (only analytics is dropped)", () => {
  const records: ChunkRecord[] = [
    pendingRecord("p1", 1000),
    decidedRecord("a1", "approved", 2000, { decidedBy: "U_SUPER" }),
  ];
  // The publish path's first fallback tier: data_visualization rejected, everything else retained.
  const blocks = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now: 3000, charts: false }).blocks as KnownBlock[];
  assert.ok(carouselOf(blocks), "carousel still rendered when only charts are dropped");
  assert.ok(kpiTableOf(blocks), "KPI table still rendered when only charts are dropped");
  assert.equal(dataViz(blocks).length, 0, "no native charts");
});

test("kpiTable:false swaps the KPI table for a one-line strip while keeping the carousel", () => {
  const records: ChunkRecord[] = [
    pendingRecord("p1", 1000),
    decidedRecord("a1", "approved", 2000, { decidedBy: "U_SUPER" }),
  ];
  // The publish path's second tier: table rejected, carousel retained.
  const blocks = buildAppHomeView({ records, detail: new Map(), config: makeConfig(), now: 3000, kpiTable: false }).blocks as KnownBlock[];
  assert.equal(kpiTableOf(blocks), undefined, "no table block when kpiTable is false");
  assert.ok(carouselOf(blocks), "carousel is still rendered");
  const text = allText(blocks);
  assert.match(text, /Pending\s+\*1\*/); // KPI strip carries the counts inline
  assert.match(text, /Approved\s+\*1\*/);
});

test("homeViewFor: non-admins get the admins-only notice; admins get the dashboard", () => {
  // homeViewFor's non-admin branch returns before touching the client/store, so stubs are safe.
  const svc = new DecisionService(makeConfig(), {} as never, { all: () => [] } as never, {} as never);

  const nonAdmin = svc.homeViewFor("U_STRANGER");
  assert.equal(nonAdmin.type, "home");
  assert.match(allText(nonAdmin.blocks as KnownBlock[]), /This view is for admins only\./);

  const admin = svc.homeViewFor("U_SUPER");
  assert.equal(admin.type, "home");
  const adminText = allText(admin.blocks as KnownBlock[]);
  assert.match(adminText, /Configuration/);
  assert.doesNotMatch(adminText, /admins only/);
});

test("homeViewFor reads the capture summary file and renders the audit charts", () => {
  const dir = mkdtempSync(join(tmpdir(), "home-audit-"));
  try {
    const summaryPath = join(dir, "audit-summary.json");
    const now = Date.now();
    const today = new Date(now).toISOString().slice(0, 10); // in the fixed 10-day window ending today
    writeFileSync(
      summaryPath,
      JSON.stringify({
        version: 1,
        updatedAt: now,
        days: { [today]: { total: 6, bySandbox: { "sbx-web": 6 }, bySeverity: { "1": 6 } } },
      }),
      "utf8",
    );
    // homeViewFor must actually read config.capture.summaryStatePath and thread it through as
    // `audit`; the other homeViewFor test points at a nonexistent path, so this is the wiring check.
    const records: ChunkRecord[] = [pendingRecord("x", now, { sandboxId: "sbx-web", sandboxName: "web-agent" })];
    const config = makeConfig({ capture: { sources: [], excludeEventTypes: [], summaryStatePath: summaryPath } });
    const svc = new DecisionService(config, {} as never, { all: () => records } as never, {} as never);

    const charts = dataViz(svc.homeViewFor("U_SUPER").blocks as KnownBlock[]);
    const bar = charts.find((c) => c.chart.type === "bar");
    assert.ok(bar, "top-sandboxes bar chart rendered from the summary file");
    assert.deepEqual(
      bar!.chart.series[0].data.map((d) => [d.label, d.value]),
      [["web-agent", 6]], // sandbox id joined to its friendly name from the records
    );
    assert.ok(
      charts.some((c) => (c.title ?? "").startsWith("Audit activity")),
      "daily audit-volume line rendered from the summary file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
