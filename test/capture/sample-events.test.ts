import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { KnownBlock } from "@slack/types";
import {
  generateSampleAuditEvents,
  seedAuditSummary,
  SAMPLE_SANDBOXES,
  SAMPLE_WINDOW_DAYS,
} from "../../src/capture/sample-events";
import { normalizeAndFilter } from "../../src/capture/pipeline";
import { readAuditSummary } from "../../src/audit-summary";
import { buildAppHomeView, ACTIVITY_DAYS, MAX_SANDBOX_BARS } from "../../src/app-home";
import type { AppConfig, AdminRole, WatchMode, OpenShellAuth } from "../../src/config";

// A fixed instant so both the generator and the App Home window are deterministic across runs.
const NOW = Date.parse("2026-06-15T09:30:00.000Z");
const DAY_MS = 86_400_000;

// The UTC day keys the App Home charts window over, ending "today" (mirrors app-home's windowDays).
function windowKeys(now: number): Set<string> {
  const keys = new Set<string>();
  for (let i = SAMPLE_WINDOW_DAYS - 1; i >= 0; i--) {
    keys.add(new Date(now - i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

// A minimal but complete AppConfig so buildAppHomeView renders without touching a real config.
function makeConfig(): AppConfig {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    openshell: { gatewayUrl: "127.0.0.1:17670", auth: { mode: "bearer", useTls: false, bearerToken: "t" } as OpenShellAuth },
    admins: [{ slack_user_id: "U_ADMIN", name: "Admin", role: "admin" as AdminRole }],
    routing: { defaultChannel: "C_APPROVALS", workspaceChannels: {} },
    settings: { rejectReasonRequired: true, destructiveRoles: ["super_admin"] as AdminRole[] },
    defaultWorkspace: "default",
    pollIntervalMs: 3000,
    pollConcurrency: 25,
    watchMode: "off" as WatchMode,
    capture: { sources: [], excludeEventTypes: [], summaryStatePath: "" },
    statePath: "",
    logLevel: "info",
  };
}

type VizBlock = {
  block_id?: string;
  title?: string;
  chart?: { type?: string; series?: { name?: string; data?: { label?: string; value?: number }[] }[] };
};
function dataViz(blocks: KnownBlock[]): VizBlock[] {
  return (blocks as unknown as ({ type?: string } & VizBlock)[]).filter(
    (b) => b.type === "data_visualization",
  );
}

test("the sample window matches the App Home activity window", () => {
  // windowKeys() and the whole-window assertions below assume the generator's window equals
  // app-home's. If ACTIVITY_DAYS ever changes without the generator, those checks would silently
  // drift, so pin the invariant explicitly.
  assert.equal(SAMPLE_WINDOW_DAYS, ACTIVITY_DAYS, "generator window must equal app-home ACTIVITY_DAYS");
});

test("generateSampleAuditEvents is deterministic for a given now", () => {
  const a = generateSampleAuditEvents(NOW);
  const b = generateSampleAuditEvents(NOW);
  assert.deepEqual(a, b, "same now must yield identical events");
  assert.ok(a.length > 100, "a demo-worthy volume of events");
});

test("every sample event falls inside the App Home chart window", () => {
  const keys = windowKeys(NOW);
  const events = generateSampleAuditEvents(NOW);
  for (const ev of events) {
    const day = new Date(ev.time as number).toISOString().slice(0, 10);
    assert.ok(keys.has(day), `event day ${day} must be one of the ${SAMPLE_WINDOW_DAYS} windowed days`);
  }
});

test("sample events span every day, more sandboxes than fit the bar chart, and multiple severities", () => {
  const events = generateSampleAuditEvents(NOW);
  const days = new Set(events.map((e) => new Date(e.time as number).toISOString().slice(0, 10)));
  const sandboxes = new Set(events.map((e) => (e.metadata as { uid?: string }).uid));
  const severities = new Set(events.map((e) => e.severity_id));

  assert.equal(days.size, SAMPLE_WINDOW_DAYS, "one bucket per windowed day, none empty");
  assert.equal(sandboxes.size, SAMPLE_SANDBOXES.length, "every declared sandbox appears");
  assert.ok(sandboxes.size > MAX_SANDBOX_BARS, "more sandboxes than bars so the bar chart overflows to 'top N of M'");
  assert.ok(severities.size >= 3, "a realistic severity mix, not a single value");
});

test("seedAuditSummary writes a summary that drives BOTH App Home audit charts", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-seed-"));
  const path = join(dir, "audit-summary.json");
  // Seed at the live clock, as the real launchers do, so the seeded days sit inside the store's
  // 30-day retention (a fixed past `now` would be pruned on flush). One captured value keeps the
  // seed, the summary window, and the App Home window aligned.
  const now = Date.now();
  try {
    const result = seedAuditSummary({ now, path });
    assert.equal(result.days, SAMPLE_WINDOW_DAYS);
    assert.ok(result.events > 100);
    assert.equal(result.sandboxes, SAMPLE_SANDBOXES.length);

    const audit = readAuditSummary(path);
    assert.ok(audit, "summary is readable");
    // Every windowed day has a non-zero total (line chart is fully populated, no flat-zero gap).
    for (const key of windowKeys(now)) {
      assert.ok((audit!.days[key]?.total ?? 0) > 0, `day ${key} has audit volume`);
    }

    const view = buildAppHomeView({ records: [], detail: new Map(), config: makeConfig(), now, audit });
    const charts = dataViz(view.blocks as KnownBlock[]);
    const ids = charts.map((c) => c.block_id);
    assert.ok(ids.includes("audit_volume"), "daily audit-volume line chart is present");
    assert.ok(ids.includes("sandbox_activity"), "top-sandboxes bar chart is present");

    // Read back the RENDERED line series (not just the summary store): every one of the
    // ACTIVITY_DAYS plotted points must be non-zero, proving the chart has no flat-zero gap.
    const line = charts.find((c) => c.block_id === "audit_volume");
    const series = line?.chart?.series?.[0]?.data ?? [];
    assert.equal(series.length, ACTIVITY_DAYS, "line chart plots one point per activity day");
    for (const point of series) {
      assert.ok((point.value ?? 0) > 0, `rendered line point ${point.label} is non-zero`);
    }

    // The bar chart's overflow label proves more sandboxes were captured than the cap shows.
    const bar = charts.find((c) => c.block_id === "sandbox_activity");
    const overflow = new RegExp(`top ${MAX_SANDBOX_BARS} of ${SAMPLE_SANDBOXES.length}`, "i");
    assert.match(String(bar?.title), overflow, `bar chart reports the overflow (top ${MAX_SANDBOX_BARS} of ${SAMPLE_SANDBOXES.length})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("seedAuditSummary reset=false accumulates; the default reset does not double-count", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-seed-"));
  const path = join(dir, "audit-summary.json");
  const now = Date.now(); // live clock so nothing is pruned by the 30-day retention
  try {
    const total = (p: string) =>
      Object.values(readAuditSummary(p)!.days).reduce((s, d) => s + d.total, 0);

    seedAuditSummary({ now, path });
    const firstTotal = total(path);
    assert.ok(firstTotal > 0, "the first seed writes a non-zero on-disk total");

    // A default (reset) re-seed unlinks first, so the ON-DISK total is reproduced, not doubled.
    seedAuditSummary({ now, path });
    const resetTotal = total(path);
    assert.equal(resetTotal, firstTotal, "default reset reproduces the same on-disk total, no double-count");

    // reset=false folds a second full spread on top, doubling the on-disk volume.
    seedAuditSummary({ now, path, reset: false });
    assert.equal(total(path), resetTotal * 2, "append doubles the on-disk counts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sample events survive the noise filter and normalize cleanly", () => {
  // Sanity: the generator emits well-formed OCSF that the real pipeline captures (never filtered).
  const events = generateSampleAuditEvents(NOW);
  assert.ok(events.length > 100, "a full spread to run through the pipeline");

  // Iterate EVERY event (not a slice) so a malformed straggler anywhere can't hide.
  for (const raw of events) {
    const ev = normalizeAndFilter(raw, []);
    assert.ok(ev, "event captured by the pipeline");
    assert.ok(ev!.sandboxUid, "sandbox uid normalized");
    assert.ok(ev!.timeMs != null, "time normalized");
    assert.ok(ev!.severityId != null, "severity normalized");
  }

  // A NON-EMPTY exclude list that matches none of the sample classes must still keep every event:
  // this drives the filter's candidate-matching branch, not the empty-list short-circuit.
  for (const raw of events) {
    assert.ok(
      normalizeAndFilter(raw, ["no-such-ocsf-class", "Nonexistent Activity"]),
      "event survives an exclude list that matches nothing",
    );
  }

  // And the filter really drops when it matches: derive a real OCSF class from the data, exclude
  // it, and confirm the matching events are filtered out (proves exclusion isn't a no-op).
  const sampleClass = normalizeAndFilter(events[0], [])!.className;
  assert.ok(sampleClass, "normalized events carry an OCSF class name to match on");
  const dropped = events.filter((raw) => normalizeAndFilter(raw, [sampleClass]) === null);
  assert.ok(dropped.length > 0, `excluding class "${sampleClass}" drops the matching events`);
});
