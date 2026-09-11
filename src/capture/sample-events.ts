// Deterministic sample OpenShell OCSF audit events for local demos. Feeding these through the
// real capture pipeline (normalize -> filter -> AuditSummaryStore) populates the App Home audit
// charts without a live OpenShell instance, so the mock launchers can light up the dashboard the
// same way scripts/send-samples.ts lights up the approval queue. The mock gateway's gRPC surface
// has NO audit stream (audit is a separate JSONL/HTTP firehose), so this stands in for the capture
// sink by writing the summary file the bridge reads.
//
// Pure and deterministic: given the same `now`, generateSampleAuditEvents returns identical events
// (no Math.random, no ambient clock beyond the passed-in `now`), so a re-seed reproduces the same
// dashboard and tests can assert exact shape. Each event is a full, realistic flattened OCSF object
// (as the JSONL file source or HTTP receiver would see it), though the summary only reads its
// `time`, `severity_id`, and `metadata.uid`.

import { existsSync, unlinkSync } from "node:fs";
import { AuditSummaryStore } from "../audit-summary";
import { normalizeAndFilter } from "./pipeline";
import { resolveSummaryStatePath } from "../config";
import { childLogger } from "../logger";

const log = childLogger("sample-events");

const DAY_MS = 86_400_000;

// One bucket per day across the App Home chart window (ACTIVITY_DAYS in app-home.ts), ending
// "today" in UTC. Kept deliberately in sync with that window; a wider span would just be pruned by
// the summary's retention and never charted.
export const SAMPLE_WINDOW_DAYS = 10;

// Per-day event volume, indexed by days-ago (0 = today). A gentle upward trend with a mid-window
// dip so the audit-volume line chart reads as organic activity rather than a flat block.
const DAILY_VOLUME = [34, 24, 31, 27, 15, 22, 18, 10, 12, 8];

export interface SampleSandbox {
  uid: string;
  image: string;
  // Relative share of events assigned to this sandbox.
  weight: number;
}

// Eight sandboxes, more than MAX_SANDBOX_BARS (6) in app-home.ts, so the "Top sandboxes by
// activity" bar chart also exercises its "top N of M" overflow label. The audit feed carries only
// the sandbox id, so these ids double as their display label (the bar chart falls back to the raw
// id for any sandbox the approval side never saw, which is every one of these under the mock).
export const SAMPLE_SANDBOXES: readonly SampleSandbox[] = [
  { uid: "web-agent", image: "ghcr.io/openshell/web-agent:1.4", weight: 9 },
  { uid: "data-pipeline", image: "ghcr.io/openshell/data-pipeline:2.0", weight: 7 },
  { uid: "ci-runner", image: "ghcr.io/openshell/ci-runner:0.9", weight: 6 },
  { uid: "notebook-agent", image: "ghcr.io/openshell/notebook:3.1", weight: 5 },
  { uid: "batch-worker", image: "ghcr.io/openshell/batch-worker:1.0", weight: 4 },
  { uid: "email-triage", image: "ghcr.io/openshell/email-triage:1.2", weight: 3 },
  { uid: "pdf-extractor", image: "ghcr.io/openshell/pdf-extractor:0.5", weight: 2 },
  { uid: "web-scraper", image: "ghcr.io/openshell/web-scraper:1.1", weight: 1 },
];

// A flat, weight-expanded sequence of sandboxes: indexing it modulo its length spreads events in
// proportion to each sandbox's weight without any per-event randomness.
const SANDBOX_SEQUENCE: SampleSandbox[] = SAMPLE_SANDBOXES.flatMap((s) => Array<SampleSandbox>(s.weight).fill(s));

// OCSF severity_id -> label. Biased toward low/medium noise with occasional highs so the severity
// mix (stored per day in the summary) looks like a real feed rather than a uniform spread.
const SEVERITY_LABELS: Record<number, string> = { 1: "Informational", 2: "Low", 3: "Medium", 4: "High", 5: "Critical" };
const SEVERITY_SEQUENCE = [1, 2, 2, 3, 3, 2, 3, 1, 4, 2, 3, 5];

// Small pools the class builders draw from, cycled by index for variety without randomness.
const HOSTS = [
  "files.pythonhosted.org",
  "registry.npmjs.org",
  "github.com",
  "api.openai.com",
  "weights.internal.example.net",
  "telemetry.example.io",
  "cdn.jsdelivr.net",
  "unknown-host.example.com",
];
const BINARIES = ["/usr/bin/curl", "/usr/bin/pip", "/usr/bin/git", "/opt/agent/runner", "/usr/bin/node", "/usr/bin/python3"];
const PATHS = [
  "/workspace/data/train.parquet",
  "/etc/resolv.conf",
  "/tmp/agent-scratch/out.json",
  "/workspace/.netrc",
  "/var/run/secrets/token",
];

// Builds the class-specific portion of one event (everything except time, severity, and the
// sandbox metadata/device/container, which the generator adds uniformly).
type ClassBuilder = (ctx: { host: string; bin: string; path: string; i: number }) => Record<string, unknown>;

const networkActivity: ClassBuilder = ({ host, i }) => {
  const allowed = i % 3 !== 0; // roughly one in three denied
  return {
    class_uid: 4001,
    class_name: "Network Activity",
    category_uid: 4,
    category_name: "Network Activity",
    activity_id: 6,
    activity_name: "Traffic",
    type_uid: 400106,
    type_name: "Network Activity: Traffic",
    status_id: allowed ? 1 : 2,
    status: allowed ? "Success" : "Failure",
    message: `${allowed ? "CONNECT allowed" : "CONNECT denied"} ${host}:443`,
    dst_endpoint: { hostname: host, port: 443 },
    firewall_rule: { name: allowed ? "allow-egress" : "default-deny" },
  };
};

const processActivity: ClassBuilder = ({ bin }) => ({
  class_uid: 1007,
  class_name: "Process Activity",
  category_uid: 1,
  category_name: "System Activity",
  activity_id: 1,
  activity_name: "Launch",
  type_uid: 100701,
  type_name: "Process Activity: Launch",
  status_id: 1,
  status: "Success",
  message: `exec ${bin}`,
  process: { cmd_line: bin, file: { path: bin } },
});

const fileActivity: ClassBuilder = ({ path }) => ({
  class_uid: 1001,
  class_name: "File System Activity",
  category_uid: 1,
  category_name: "System Activity",
  activity_id: 3,
  activity_name: "Read",
  type_uid: 100103,
  type_name: "File System Activity: Read",
  status_id: 1,
  status: "Success",
  message: `read ${path}`,
  file: { path, type_id: 1 },
});

const detectionFinding: ClassBuilder = ({ host, i }) => ({
  class_uid: 2004,
  class_name: "Detection Finding",
  category_uid: 2,
  category_name: "Findings",
  activity_id: 1,
  activity_name: "Create",
  type_uid: 200401,
  type_name: "Detection Finding: Create",
  status_id: 1,
  status: "Success",
  message: `policy violation: egress to ${host} blocked`,
  finding_info: { title: "Unapproved egress", uid: `find-${i}` },
  // Exercise the OCSF `unmapped` fold (policy markers OpenShell attaches to some events).
  unmapped: { policy_version: 7 + (i % 5) },
});

// Weighted so network traffic dominates (the common case), with process/file activity and the
// occasional security finding mixed in.
const CLASS_SEQUENCE: ClassBuilder[] = [
  networkActivity,
  networkActivity,
  networkActivity,
  processActivity,
  processActivity,
  fileActivity,
  fileActivity,
  networkActivity,
  detectionFinding,
  processActivity,
];

// Generate the full spread of sample OCSF events for the window ending at `now` (epoch ms),
// oldest day first. Every event's `time` sits inside its UTC day (08:00-17:59) so it buckets to
// the intended day; the day keys are computed exactly as app-home's window is, so each event lands
// in a charted bucket.
export function generateSampleAuditEvents(now: number): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];
  for (let daysAgo = SAMPLE_WINDOW_DAYS - 1; daysAgo >= 0; daysAgo--) {
    const dayKey = new Date(now - daysAgo * DAY_MS).toISOString().slice(0, 10);
    const dayStartMs = Date.parse(`${dayKey}T00:00:00.000Z`);
    const total = DAILY_VOLUME[daysAgo] ?? 0;
    for (let j = 0; j < total; j++) {
      const sandbox = SANDBOX_SEQUENCE[(j + daysAgo * 3) % SANDBOX_SEQUENCE.length];
      const severityId = SEVERITY_SEQUENCE[(j + daysAgo) % SEVERITY_SEQUENCE.length];
      const build = CLASS_SEQUENCE[(j + daysAgo * 2) % CLASS_SEQUENCE.length];
      const host = HOSTS[(j + daysAgo) % HOSTS.length];
      const bin = BINARIES[j % BINARIES.length];
      const path = PATHS[(j + daysAgo) % PATHS.length];
      // Keep the event strictly inside its UTC day (08:00:00 through 17:59:59) so dayKey bucketing
      // never spills into an adjacent day regardless of the wall-clock time `now` was taken at.
      const secondsIntoDay = (8 + (j % 10)) * 3600 + ((j * 7) % 60) * 60 + ((j * 13) % 60);
      events.push({
        ...build({ host, bin, path, i: j }),
        time: dayStartMs + secondsIntoDay * 1000,
        severity_id: severityId,
        severity: SEVERITY_LABELS[severityId],
        metadata: {
          version: "1.8.0",
          product: { name: "OpenShell Sandbox Supervisor", vendor_name: "OpenShell" },
          uid: sandbox.uid,
        },
        device: { hostname: sandbox.uid, os: { name: "Linux" } },
        container: { name: sandbox.uid, uid: sandbox.uid, image: { name: sandbox.image } },
      });
    }
  }
  return events;
}

export interface SeedAuditResult {
  path: string;
  events: number;
  days: number;
  sandboxes: number;
}

// Generate the sample events and fold them into the audit summary at `path` (default: the same
// path the bridge reads, resolveSummaryStatePath). Runs each event through the REAL capture
// pipeline (normalize + noise filter) and the REAL AuditSummaryStore, so the file is written
// exactly as the production sink would write it. `reset` (default true) clears any existing summary
// first so a re-seed reproduces the same demo dashboard rather than doubling counts; pass false to
// accumulate onto whatever is already there.
export function seedAuditSummary(opts: { now: number; path?: string; reset?: boolean }): SeedAuditResult {
  const path = opts.path ?? resolveSummaryStatePath();
  const reset = opts.reset !== false;
  if (reset && existsSync(path)) unlinkSync(path);

  const store = new AuditSummaryStore(path);
  const days = new Set<string>();
  const sandboxes = new Set<string>();
  let recorded = 0;
  for (const raw of generateSampleAuditEvents(opts.now)) {
    const ev = normalizeAndFilter(raw, []); // empty exclude list captures everything
    if (!ev) continue;
    store.record(ev);
    recorded += 1;
    if (ev.timeMs != null) days.add(new Date(ev.timeMs).toISOString().slice(0, 10));
    if (ev.sandboxUid) sandboxes.add(ev.sandboxUid);
  }
  // Clear the coalescing flush timer and force a final, synchronous write so the summary is on disk
  // before we return (and before the caller logs "seeded").
  store.stop();

  log.info(
    { path, events: recorded, days: days.size, sandboxes: sandboxes.size, reset },
    "Seeded App Home audit summary from sample events.",
  );
  return { path, events: recorded, days: days.size, sandboxes: sandboxes.size };
}
