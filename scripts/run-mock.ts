/**
 * Launch the mock OpenShell gateway for interactive live testing, seeding ONLY the
 * allow-pypi (python) proposal as pending. The allow-model-host seed is force-closed and the
 * CLI demo's late telemetry injection is skipped, so a running bridge posts exactly one
 * approval card. Keeps the process alive so the bridge stays connected over gRPC.
 *
 * Also seeds the App Home audit charts: the gRPC gateway has no audit stream (audit is a separate
 * firehose), so a full spread of sample OCSF events is written to the audit summary the bridge
 * reads, and the dashboard's daily-volume line and top-sandboxes bar populate the moment the Home
 * tab opens. Set MOCK_SKIP_AUDIT_SEED=true to skip it.
 *
 * Insecure localhost listener; run the bridge with OPENSHELL_USE_TLS=false.
 *
 *   node --import tsx scripts/run-mock.ts
 *   MOCK_ADDR=127.0.0.1:17670 node --import tsx scripts/run-mock.ts
 */
import "dotenv/config"; // load .env first so MOCK_ADDR / CAPTURE_SUMMARY_STATE match the bridge
import { startMockServer, resetMockState, forceCloseChunk } from "../src/mock-server";
import { seedAuditSummary } from "../src/capture/sample-events";
import { childLogger } from "../src/logger";

const log = childLogger("run-mock");
const ADDR = process.env.MOCK_ADDR || "127.0.0.1:17670";

async function main(): Promise<void> {
  resetMockState(); // seeds allow-pypi (chunk-1) + allow-model-host (chunk-2), both pending
  forceCloseChunk("web-agent", "chunk-2"); // leave only the python (allow-pypi) proposal pending
  const { port } = await startMockServer(ADDR);
  log.info({ addr: ADDR, port }, "Mock gateway up (allow-pypi pending only; no telemetry inject).");

  // Populate the App Home audit charts so the dashboard is not empty. Best-effort: a seed failure
  // must never stop the gateway (its core job is serving the approval flow over gRPC).
  if (process.env.MOCK_SKIP_AUDIT_SEED !== "true") {
    try {
      const seed = seedAuditSummary({ now: Date.now() });
      log.info(
        { events: seed.events, days: seed.days, sandboxes: seed.sandboxes, path: seed.path },
        "Seeded App Home audit charts (daily volume + top sandboxes).",
      );
    } catch (err) {
      log.warn({ err }, "Could not seed audit charts; the gateway is up but App Home audit charts will be empty.");
    }
  }
}

main().catch((err) => {
  log.error({ err }, "Mock launcher failed.");
  process.exit(1);
});
