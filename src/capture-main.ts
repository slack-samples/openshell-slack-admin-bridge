import "dotenv/config";
import { createSlackPoster } from "./capture/slack-poster";
import { loadConfig, captureEnabled, hasCaptureSource } from "./config";
import { childLogger } from "./logger";
import { SendQueue } from "./capture/send-queue";
import { createIngestor, type AuditSink } from "./capture/pipeline";
import { AuditSummaryStore } from "./audit-summary";
import { FileSource } from "./capture/file-source";
import { Receiver } from "./capture/receiver";

// The audit sink: a standalone process, structurally isolated from the
// approve/reject bridge (index.ts). It shares only config.ts, never imports the
// decision path or the gRPC client. It ingests OpenShell's OCSF events from a
// tailed JSONL file, an inbound HTTP receiver, or both, and does two things with
// each (filtered) event: it ALWAYS accumulates activity counts into the audit
// summary the bridge reads for App Home charts, and — only when routing.
// audit_channel is set (opt-in) — it also forwards the rendered card to Slack
// through a bounded, rate-limited queue. It performs NO dedup: this is an
// independent firehose, and an approval-outcome event also appearing here is
// acceptable.

const log = childLogger("capture-main");

async function main(): Promise<void> {
  const config = loadConfig();

  if (!captureEnabled(config)) {
    log.info("Capture has no ingestion sources (CAPTURE_SOURCES is empty); the audit sink has nothing to ingest.");
    return;
  }

  // Always accumulate the audit-activity summary the bridge reads for App Home
  // charts, whether or not we also post to Slack.
  const summary = new AuditSummaryStore(config.capture.summaryStatePath);

  // Slack posting is opt-in: only when routing.audit_channel is configured.
  // Without it, capture still ingests and updates the summary, but posts nothing.
  const auditChannel = config.routing.auditChannel;
  let queue: SendQueue | null = null;
  let sink: AuditSink;
  if (auditChannel) {
    queue = new SendQueue({
      post: createSlackPoster(config.slack.botToken, auditChannel, (receipt) => {
        // Record Slack's acknowledgement, never message bodies or credentials.
        log.info(receipt, "Audit message delivered to Slack.");
      }),
    });
    queue.start();
    const q = queue;
    sink = (post) => q.enqueue(post);
  } else {
    // Summary-only: swallow rendered cards (nothing is posted). The summary tap
    // below still counts every captured event.
    sink = () => true;
  }

  const ingest = createIngestor(config.capture.excludeEventTypes, sink, (ev) => summary.record(ev));

  let fileSource: FileSource | null = null;
  let receiver: Receiver | null = null;

  if (hasCaptureSource(config, "file")) {
    fileSource = new FileSource({
      path: config.capture.filePath!,
      offsetStatePath: config.capture.offsetStatePath!,
      onLine: (line) => {
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          // A partial or non-JSON line: skip it rather than crash the tailer. The
          // file source only ever hands us complete lines, so this is genuinely
          // malformed content, not a torn write.
          log.warn("Skipped a non-JSON line from the OCSF log file.");
          return;
        }
        ingest(obj);
      },
    });
    fileSource.start();
    log.info({ path: config.capture.filePath }, "Tailing OCSF log file.");
  }

  if (hasCaptureSource(config, "http")) {
    receiver = new Receiver({
      bind: config.capture.receiverBind!,
      token: config.capture.receiverToken!,
      tlsCertPath: config.capture.receiverTlsCertPath,
      tlsKeyPath: config.capture.receiverTlsKeyPath,
      ingest,
    });
    await receiver.start();
  }

  log.info(
    {
      sources: config.capture.sources,
      channel: auditChannel ?? null,
      posting: Boolean(auditChannel),
      summary: config.capture.summaryStatePath,
    },
    auditChannel
      ? "Audit sink started (posting to Slack + writing summary)."
      : "Audit sink started (summary only; set routing.audit_channel to also post to Slack).",
  );

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal, queue: queue?.stats() }, "Shutting down audit sink.");
    fileSource?.stop();
    // Force a final summary write so counts buffered since the last coalesced
    // flush are not lost.
    summary.stop();
    // Stop accepting new work, flush what is queued (still rate-limited), and
    // close the receiver, then exit. queue.stop() is bounded by the backlog.
    void Promise.allSettled([receiver?.stop(), queue?.stop()]).then(() => {
      log.info({ queue: queue?.stats() }, "Audit sink stopped.");
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  log.error({ err }, "Fatal audit-sink startup error.");
  process.exit(1);
});
