/**
 * Inject sample egress-approval proposals into a RUNNING mock OpenShell gateway, so a live
 * bridge posts approval cards and populates App Home. Uses the same SubmitPolicyAnalysis RPC an
 * in-sandbox agent would. Safe to run repeatedly; each run appends new pending chunks.
 *
 *   node --import tsx scripts/send-samples.ts
 *   MOCK_ADDR=127.0.0.1:17670 node --import tsx scripts/send-samples.ts
 *
 * Requires the mock (scripts/run-mock.ts) and, to see cards, the bridge to be running.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { childLogger } from "../src/logger";

const log = childLogger("send-samples");
const ADDR = process.env.MOCK_ADDR || "127.0.0.1:17670";
const SANDBOX = process.env.SAMPLE_SANDBOX || "web-agent";

function endpoint(host: string, ports: number[], rules: { method: string; path: string }[] = []) {
  return { host, ports, protocol: "tcp", allowed_ips: [], rules, deny_rules: [] };
}

// Three varied proposals: a deterministic (mechanistic) one, an agent-authored one that is
// security-flagged and carries an L7 rule, and a plain agent-authored one.
const proposedChunks = [
  {
    rule_name: "allow-pypi-mirror",
    proposed_rule: {
      name: "allow-pypi-mirror",
      endpoints: [endpoint("files.pythonhosted.org", [443])],
      binaries: [{ path: "/usr/bin/pip" }],
    },
    rationale: "Deterministic match against the known package-registry allowlist; pip attempted an outbound HTTPS fetch.",
    security_notes: "",
    confidence: 0, // mechanistic
    denial_summary_ids: ["ds-101", "ds-102"],
    hit_count: 6,
    stage: "initial",
    created_at_ms: "1735689600000",
  },
  {
    rule_name: "allow-model-weights",
    proposed_rule: {
      name: "allow-model-weights",
      endpoints: [endpoint("weights.example.net", [443], [{ method: "GET", path: "/models/*" }])],
      binaries: [{ path: "/opt/agent/runner" }],
    },
    rationale: "Agent requested a model-weights host not present on any known allowlist.",
    security_notes: "Destination is an uncategorized host; verify it is a trusted weights mirror before approving.",
    confidence: 0.82, // agent-authored, security flagged
    denial_summary_ids: ["ds-201"],
    hit_count: 2,
    stage: "initial",
    created_at_ms: "1735689600000",
  },
  {
    rule_name: "allow-telemetry",
    proposed_rule: {
      name: "allow-telemetry",
      endpoints: [endpoint("telemetry.vendor.io", [443])],
      binaries: [{ path: "/opt/agent/runner" }],
    },
    rationale: "Agent attempted to POST anonymous usage telemetry to an unlisted host.",
    security_notes: "",
    confidence: 0.5, // agent-authored
    denial_summary_ids: ["ds-301"],
    hit_count: 1,
    stage: "initial",
    created_at_ms: "1735689600000",
  },
];

function resolveProtoDir(): string {
  const candidates = [process.env.OPENSHELL_PROTO_DIR, join(__dirname, "..", "proto"), join(process.cwd(), "proto")]
    .filter((p): p is string => !!p);
  for (const dir of candidates) if (existsSync(join(dir, "openshell.proto"))) return dir;
  throw new Error("Could not locate proto/openshell.proto");
}

function loadClient(): grpc.Client & Record<string, (...a: unknown[]) => unknown> {
  const def = protoLoader.loadSync("openshell.proto", {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [resolveProtoDir()],
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    openshell: { v1: { OpenShell: grpc.ServiceClientConstructor } };
  };
  return new pkg.openshell.v1.OpenShell(ADDR, grpc.credentials.createInsecure()) as never;
}

async function main(): Promise<void> {
  const client = loadClient();
  const req = { name: SANDBOX, proposed_chunks: proposedChunks, analysis_mode: "agent_authored", workspace: "default" };
  const res = await new Promise<{ accepted_chunk_ids?: string[]; accepted_chunks?: number }>((resolvePromise, reject) => {
    client.SubmitPolicyAnalysis(req, (err: grpc.ServiceError | null, r: unknown) => (err ? reject(err) : resolvePromise(r as never)));
  });
  log.info(
    { sandbox: SANDBOX, accepted: res.accepted_chunks, chunkIds: res.accepted_chunk_ids, rules: proposedChunks.map((c) => c.rule_name) },
    "Submitted sample proposals. A running bridge will post them within one poll (~3s).",
  );
  client.close();
}

main().catch((err) => {
  log.error({ err }, "Failed to submit sample proposals. Is the mock running on " + ADDR + "?");
  process.exit(1);
});
