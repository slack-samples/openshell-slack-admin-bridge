// Isolated contract smoke test: synthetic OCSF -> actual exporter image ->
// HTTPS receiver -> real normalization/rendering, with NO Slack API calls.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { Receiver } from "../src/capture/receiver";
import { createIngestor } from "../src/capture/pipeline";
import type { NormalizedAuditEvent } from "../src/capture/normalize";
import type { RenderedAudit } from "../src/capture/blocks";

async function main() {
  const tlsDir = process.argv[2];
  if (!tlsDir) throw new Error("usage: node --import tsx scripts/verify-research-exporter.ts TLS_DIRECTORY [IMAGE]");
  const image = process.argv[3] ?? "openshell-slack-demo-exporter:research-26dbfd5";
  const dir = mkdtempSync(join(tmpdir(), "slack-research-contract-"));
  const container = `slack-research-contract-${randomUUID()}`;
  const token = randomUUID();
  const captured: NormalizedAuditEvent[] = [];
  const rendered: RenderedAudit[] = [];
  const receiver = new Receiver({
    bind: "0.0.0.0:0", token,
    tlsCertPath: resolve(tlsDir, "slack-capture.crt"),
    tlsKeyPath: resolve(tlsDir, "slack-capture.key"),
    ingest: createIngestor([], m => (rendered.push(m), true), e => captured.push(e)),
  });
  let started = false;
  try {
    await receiver.start();
    const event = JSON.parse(readFileSync(join(__dirname, "../test/fixtures/research-exporter/ocsf-network-denial.json"), "utf8"));
    writeFileSync(join(dir, "input.jsonl"), `${JSON.stringify(event.data.original)}\n`, { mode: 0o644 });
    copyFileSync(resolve(tlsDir, "ca.crt"), join(dir, "ca.crt"));
    const config = {
      receivers: { "file_log/synthetic": {
        include: ["/contract/input.jsonl"], start_at: "beginning",
        attributes: { "openshell.acquisition.kind": "ocsf.file", "openshell.acquisition.source_instance": "research-contract" },
        operators: [{ type: "json_parser", parse_from: "body", parse_to: "body" }],
      } },
      processors: { openshell: {
        source_profiles: ["ocsf.file"], gateway_id: "synthetic-gateway",
        workspace: "default", source_instance: "research-contract", default_sandbox_id: "sandbox-123",
        validation: { mode: "mark" },
      } },
      exporters: { "cloudevents/contract": {
        endpoint: `https://host.docker.internal:${receiver.address()!.port}/v1/events`,
        default_source: "openshell://synthetic-gateway", timeout: "5s",
        headers: { Authorization: `Bearer ${token}` }, tls: { ca_file: "/contract/ca.crt" },
        sending_queue: { enabled: false },
      } },
      service: { pipelines: { logs: {
        receivers: ["file_log/synthetic"], processors: ["openshell"], exporters: ["cloudevents/contract"],
      } } },
    };
    writeFileSync(join(dir, "config.yaml"), YAML.stringify(config), { mode: 0o600 });
    execFileSync("docker", ["run", "--rm", "--detach", "--name", container,
      "--platform", "linux/amd64", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--add-host", "host.docker.internal:host-gateway", "--mount", `type=bind,source=${dir},target=/contract,readonly`,
      image, "--config", "/contract/config.yaml"], { stdio: "pipe", timeout: 30000 });
    started = true;
    const deadline = Date.now() + 60000;
    while (!captured.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
    assert.equal(captured.length, 1, "actual exporter must deliver exactly one synthetic event");
    assert.equal(captured[0].sandboxUid, "sandbox-123");
    assert.equal(captured[0].classUid, 4001);
    assert.equal(captured[0].severityId, 4);
    assert.equal(captured[0].message, "CONNECT denied api.example.com:443");
    assert.match(JSON.stringify(rendered[0]), /request-123/);
    console.log(JSON.stringify({ ok: true, image, events: captured.length, tls: "verified", slackApiCalls: 0 }));
  } finally {
    if (started) {
      try { execFileSync("docker", ["stop", "--time", "5", container], { stdio: "pipe", timeout: 15000 }); }
      catch { console.error(`Could not stop test container ${container}; inspect it manually.`); }
    }
    await receiver.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
main().catch(err => { console.error(err.message); process.exitCode = 1; });
