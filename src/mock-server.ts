import { existsSync } from "node:fs";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { childLogger } from "./logger";

const log = childLogger("mock-server");

const ADDR = process.env.MOCK_ADDR || "127.0.0.1:17670";

function resolveProtoDir(): string {
  const candidates = [
    process.env.OPENSHELL_PROTO_DIR,
    join(__dirname, "..", "proto"),
    join(__dirname, "..", "..", "proto"),
    join(process.cwd(), "proto"),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    if (existsSync(join(dir, "openshell.proto"))) return dir;
  }
  throw new Error("Could not locate proto/openshell.proto for the mock server.");
}

// --- In-memory fixture state ------------------------------------------------

interface MockChunk {
  id: string;
  status: string;
  rule_name: string;
  proposed_rule: unknown;
  rationale: string;
  security_notes: string;
  confidence: number;
  denial_summary_ids: string[];
  created_at_ms: string;
  hit_count: number;
  stage: string;
  review_token: string;
  rejection_reason?: string;
}

interface MockSandbox {
  metadata: { id: string; name: string; workspace: string; created_at_ms: string };
  status: { phase: number };
}

let policyVersion = 1;

const sandboxes: MockSandbox[] = [
  {
    metadata: { id: "sbx-001", name: "web-agent", workspace: "default", created_at_ms: "1700000000000" },
    status: { phase: 2 }, // READY
  },
];

function endpoint(host: string, ports: number[], protocol = "tcp") {
  // Use the canonical repeated `ports` field; leave the scalar `port` unset.
  return { host, ports, protocol, allowed_ips: [], rules: [], deny_rules: [] };
}

let chunkSeq = 1;
function newChunk(overrides: Partial<MockChunk>): MockChunk {
  const id = `chunk-${chunkSeq++}`;
  return {
    id,
    status: "pending",
    rule_name: "allow-egress",
    proposed_rule: { name: "allow-egress", endpoints: [endpoint("api.example.com", [443])], binaries: [{ path: "/usr/bin/curl" }] },
    rationale: "Agent attempted an outbound HTTPS request that current policy denies.",
    security_notes: "",
    confidence: 0,
    denial_summary_ids: ["ds-1"],
    created_at_ms: "1700000001000",
    hit_count: 1,
    stage: "initial",
    review_token: `rt-${id}-v1`,
    ...overrides,
  };
}

const chunksBySandbox = new Map<string, MockChunk[]>();

// (Re)initialize the in-memory fixtures to a known-good seed. Exported for tests so each
// scenario starts from a clean, deterministic state.
export function resetMockState(): void {
  policyVersion = 1;
  chunkSeq = 1;
  chunksBySandbox.clear();
  chunksBySandbox.set("web-agent", [
    newChunk({
      rule_name: "allow-pypi",
      proposed_rule: { name: "allow-pypi", endpoints: [endpoint("pypi.org", [443])], binaries: [{ path: "/usr/bin/pip" }] },
      rationale: "Deterministic match against the known package-registry allowlist.",
      confidence: 0, // mechanistic
    }),
    newChunk({
      rule_name: "allow-model-host",
      proposed_rule: { name: "allow-model-host", endpoints: [endpoint("weights.example.net", [443])], binaries: [{ path: "/opt/agent/runner" }] },
      rationale: "Agent requested a model-weights host not on any known allowlist.",
      security_notes: "Destination is an uncategorized host; verify it is a trusted weights mirror.",
      confidence: 0.72, // agent-authored
    }),
  ]);
}
resetMockState();

// Rotate a pending chunk's review_token, simulating a re-analysis cycle that invalidates
// the token the bridge captured earlier. Returns the new token (or undefined if not found).
export function rotateReviewToken(name: string, chunkId: string): string | undefined {
  const chunk = findChunk(name, chunkId);
  if (!chunk) return undefined;
  chunk.review_token = `${chunk.review_token}-rot`;
  return chunk.review_token;
}

// Decide a chunk outside the bridge, so it stops appearing as pending. Used to exercise the
// poller's out-of-band closure detection.
export function forceCloseChunk(name: string, chunkId: string): void {
  const chunk = findChunk(name, chunkId);
  if (chunk) chunk.status = "approved";
}

function pendingFor(name: string): MockChunk[] {
  return (chunksBySandbox.get(name) ?? []).filter((c) => c.status === "pending");
}

function findChunk(name: string, chunkId: string): MockChunk | undefined {
  return (chunksBySandbox.get(name) ?? []).find((c) => c.id === chunkId);
}

type Handler = (call: { request: Record<string, unknown> }, cb: (err: grpc.ServiceError | null, res?: unknown) => void) => void;

const handlers: Record<string, Handler> = {
  ListSandboxes: (_call, cb) => cb(null, { sandboxes }),

  GetSandbox: (call, cb) => {
    const name = call.request.name as string;
    const sb = sandboxes.find((s) => s.metadata.name === name);
    if (!sb) return cb({ code: grpc.status.NOT_FOUND, message: "sandbox not found" } as grpc.ServiceError);
    cb(null, { sandbox: sb });
  },

  GetDraftPolicy: (call, cb) => {
    const name = call.request.name as string;
    const filter = (call.request.status_filter as string) || "";
    const all = chunksBySandbox.get(name) ?? [];
    const chunks = filter ? all.filter((c) => c.status === filter) : all;
    cb(null, { chunks, rolling_summary: "", draft_version: String(policyVersion), last_analyzed_at_ms: "1700000002000" });
  },

  ApproveDraftChunk: (call, cb) => {
    const name = call.request.name as string;
    const chunkId = call.request.chunk_id as string;
    const token = call.request.review_token as string;
    const chunk = findChunk(name, chunkId);
    if (!chunk) return cb({ code: grpc.status.NOT_FOUND, message: "chunk not found" } as grpc.ServiceError);
    if (chunk.status !== "pending") return cb({ code: grpc.status.FAILED_PRECONDITION, message: "not pending" } as grpc.ServiceError);
    if (token !== chunk.review_token) {
      return cb({ code: grpc.status.FAILED_PRECONDITION, message: "stale review_token" } as grpc.ServiceError);
    }
    chunk.status = "approved";
    policyVersion += 1;
    log.info({ chunkId }, "Mock approved chunk.");
    cb(null, { policy_version: policyVersion, policy_hash: `hash-${policyVersion}` });
  },

  RejectDraftChunk: (call, cb) => {
    const name = call.request.name as string;
    const chunkId = call.request.chunk_id as string;
    const chunk = findChunk(name, chunkId);
    if (!chunk) return cb({ code: grpc.status.NOT_FOUND, message: "chunk not found" } as grpc.ServiceError);
    chunk.status = "rejected";
    chunk.rejection_reason = (call.request.reason as string) || "";
    log.info({ chunkId }, "Mock rejected chunk.");
    cb(null, {});
  },

  ApproveAllDraftChunks: (call, cb) => {
    const name = call.request.name as string;
    let approved = 0;
    for (const c of pendingFor(name)) {
      c.status = "approved";
      approved += 1;
    }
    policyVersion += 1;
    cb(null, { policy_version: policyVersion, policy_hash: `hash-${policyVersion}`, chunks_approved: approved, chunks_skipped: 0 });
  },

  SubmitPolicyAnalysis: (call, cb) => {
    const name = (call.request.name as string) || "web-agent";
    const proposed = (call.request.proposed_chunks as MockChunk[]) ?? [];
    const list = chunksBySandbox.get(name) ?? [];
    const acceptedIds: string[] = [];
    for (const p of proposed) {
      // The gateway owns id/status/review_token. A client's proto3 scalar defaults arrive as
      // "" (not absent), so spreading the request verbatim would clobber newChunk's generated
      // id and token with empty strings. Drop those fields and let the server assign them.
      const proposal: Partial<MockChunk> = { ...p };
      delete proposal.id;
      delete proposal.review_token;
      const c = newChunk({ ...proposal, status: "pending" });
      list.push(c);
      acceptedIds.push(c.id);
    }
    chunksBySandbox.set(name, list);
    cb(null, { accepted_chunks: acceptedIds.length, rejected_chunks: 0, rejection_reasons: [], accepted_chunk_ids: acceptedIds });
  },

  GetDraftHistory: (_call, cb) => cb(null, { entries: [] }),

  GetSandboxPolicyStatus: (_call, cb) =>
    cb(null, {
      // Must be a valid PolicyStatus enum name; bare "LOADED" silently encodes as 0.
      revision: { version: policyVersion, policy_hash: `hash-${policyVersion}`, status: "POLICY_STATUS_LOADED" },
      active_version: policyVersion,
    }),
};

// Streaming stub so a WatchSandbox call does not hang the client.
function watchSandbox(call: { end: () => void }): void {
  call.end();
}

// Push a fresh proposal (used by the CLI demo to exercise the poller's chunk_new path).
// Returns the id of the injected chunk.
export function injectLateProposal(): string {
  const list = chunksBySandbox.get("web-agent") ?? [];
  const chunk = newChunk({
    rule_name: "allow-telemetry",
    proposed_rule: { name: "allow-telemetry", endpoints: [endpoint("telemetry.example.io", [443])], binaries: [{ path: "/opt/agent/runner" }] },
    rationale: "Late-arriving denial: agent tried to POST telemetry to an unlisted host.",
    confidence: 0.4,
  });
  list.push(chunk);
  chunksBySandbox.set("web-agent", list);
  log.info({ chunkId: chunk.id }, "Injected a late proposal (allow-telemetry) for poller demo.");
  return chunk.id;
}

export interface MockServerHandle {
  server: grpc.Server;
  port: number;
  close: () => void;
}

// Start the mock gateway. Pass addr "127.0.0.1:0" to bind an ephemeral port (tests).
export function startMockServer(addr: string = ADDR): Promise<MockServerHandle> {
  const protoDir = resolveProtoDir();
  const def = protoLoader.loadSync("openshell.proto", {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [protoDir],
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    openshell: { v1: { OpenShell: grpc.ServiceClientConstructor } };
  };
  const service = pkg.openshell.v1.OpenShell.service;

  const server = new grpc.Server();
  // Only the RPCs the service actually defines will bind; extras are ignored by grpc-js.
  server.addService(service, { ...handlers, WatchSandbox: watchSandbox } as unknown as grpc.UntypedServiceImplementation);

  return new Promise<MockServerHandle>((resolvePromise, reject) => {
    server.bindAsync(addr, grpc.ServerCredentials.createInsecure(), (err, port) => {
      if (err) {
        reject(err);
        return;
      }
      resolvePromise({ server, port, close: () => server.forceShutdown() });
    });
  });
}

if (require.main === module) {
  startMockServer(ADDR)
    .then(({ port }) => {
      log.info({ addr: ADDR, port }, "Mock OpenShell gateway listening (insecure). Set OPENSHELL_USE_TLS=false in .env.");
      // Populate the App Home audit charts (the gRPC surface has no audit stream, so seed the
      // summary the bridge reads directly). Best-effort; a seed failure never stops the gateway.
      // Import lazily so the audit/summary graph (and dotenv) is only pulled in when running as a
      // CLI, not when tests import startMockServer. Loading dotenv here makes the seed honor a
      // CAPTURE_SUMMARY_STATE set in .env, i.e. write the SAME summary path the bridge reads.
      // Set MOCK_SKIP_AUDIT_SEED=true to skip.
      if (process.env.MOCK_SKIP_AUDIT_SEED !== "true") {
        void import("dotenv/config")
          .then(() => import("./capture/sample-events"))
          .then(({ seedAuditSummary }) => {
            const seed = seedAuditSummary({ now: Date.now() });
            log.info(
              { events: seed.events, days: seed.days, sandboxes: seed.sandboxes, path: seed.path },
              "Seeded App Home audit charts (daily volume + top sandboxes).",
            );
          })
          .catch((err) => log.warn({ err }, "Could not seed App Home audit charts; they will be empty."));
      }
      // Inject a fresh proposal after a delay so the poller demonstrates chunk_new.
      setTimeout(injectLateProposal, 12_000);
    })
    .catch((err) => {
      log.error({ err }, "Mock server failed to bind.");
      process.exit(1);
    });
}
