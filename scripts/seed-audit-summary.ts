/**
 * (Re)seed the App Home audit-activity summary with a full, realistic spread of OpenShell OCSF
 * audit events, so the bridge shows populated audit charts (daily-volume line + top-sandboxes bar)
 * with no live OpenShell instance. Events run through the SAME capture pipeline the real sink uses
 * (normalize -> filter -> AuditSummaryStore), so the summary is written exactly as production would.
 *
 * scripts/run-mock.ts (and `npm run dev:mock`) call this automatically on startup. Run it standalone
 * to re-seed without restarting the mock, e.g. after clearing state:
 *
 *   node --import tsx scripts/seed-audit-summary.ts            # reset, then seed the demo summary
 *   node --import tsx scripts/seed-audit-summary.ts --append   # accumulate onto existing counts
 *
 * Honors CAPTURE_SUMMARY_STATE (else ./state/audit-summary.json), the same path the bridge reads.
 * Loads .env via dotenv first, so a CAPTURE_SUMMARY_STATE set there resolves to the bridge's path.
 */
import "dotenv/config";
import { seedAuditSummary, SAMPLE_WINDOW_DAYS } from "../src/capture/sample-events";
import { childLogger } from "../src/logger";

const log = childLogger("seed-audit-summary");

function main(): void {
  const reset = !process.argv.includes("--append");
  const result = seedAuditSummary({ now: Date.now(), reset });
  log.info(
    { ...result, windowDays: SAMPLE_WINDOW_DAYS, reset },
    `Seeded ${result.events} audit events across ${result.days} days / ${result.sandboxes} sandboxes.`,
  );
  log.info(`App Home audit charts will populate from ${result.path}. Start the bridge and open its Home tab.`);
}

main();
