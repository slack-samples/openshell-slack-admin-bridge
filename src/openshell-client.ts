import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { OpenShellAuth } from "./config";
import { childLogger } from "./logger";

const log = childLogger("openshell-client");

// ---------------------------------------------------------------------------
// Wire types. proto-loader runs with keepCase:true, so field names stay snake_case
// exactly as in the .proto files. longs:String -> int64/uint64 arrive as strings.
// ---------------------------------------------------------------------------

export interface ObjectMeta {
  id: string;
  name: string;
  created_at_ms?: string;
  labels?: Record<string, string>;
  resource_version?: string;
  annotations?: Record<string, string>;
  workspace?: string;
  deletion_timestamp_ms?: string;
}

export interface SandboxStatus {
  phase?: string; // SandboxPhase enum as string (enums:String); READY == "SANDBOX_PHASE_READY"
  [k: string]: unknown;
}

export interface Sandbox {
  metadata?: ObjectMeta;
  spec?: unknown;
  status?: SandboxStatus;
}

export interface L7Rule {
  method?: string;
  path?: string;
  [k: string]: unknown;
}

export interface L7DenyRule {
  [k: string]: unknown;
}

export interface NetworkEndpoint {
  host?: string;
  port?: number | string;
  protocol?: string;
  rules?: L7Rule[];
  allowed_ips?: string[];
  ports?: number[];
  deny_rules?: L7DenyRule[];
}

export interface NetworkBinary {
  path?: string;
  harness?: string; // deprecated
}

export interface NetworkPolicyRule {
  name?: string;
  endpoints?: NetworkEndpoint[];
  binaries?: NetworkBinary[];
}

export interface SandboxPolicy {
  [k: string]: unknown;
}

export interface L7RequestSample {
  method?: string;
  path?: string;
  decision?: string;
  count?: number;
}

export interface DenialSummary {
  sandbox_id?: string;
  host?: string;
  port?: number;
  binary?: string;
  ancestors?: string[];
  deny_reason?: string;
  first_seen_ms?: string;
  last_seen_ms?: string;
  count?: number;
  suppressed_count?: number;
  total_count?: number;
  sample_cmdlines?: string[];
  binary_sha256?: string;
  persistent?: boolean;
  denial_stage?: string; // "l4_deny" | "l7_deny" | "l7_audit" | "ssrf"
  l7_request_samples?: L7RequestSample[];
  l7_inspection_active?: boolean;
}

// The draft proposal unit. 24 fields; we type all of them so nothing is silently dropped.
export interface PolicyChunk {
  id: string;
  status: string; // "pending" | "approved" | "rejected"
  rule_name?: string;
  proposed_rule?: NetworkPolicyRule;
  rationale?: string;
  security_notes?: string;
  confidence?: number; // float; == 0 implies a mechanistic (non-LLM) proposal
  denial_summary_ids?: string[];
  created_at_ms?: string;
  decided_at_ms?: string;
  stage?: string; // "initial" | "refined"
  supersedes_chunk_id?: string;
  hit_count?: number;
  first_seen_ms?: string;
  last_seen_ms?: string;
  binary?: string;
  validation_result?: string;
  rejection_reason?: string;
  application_error?: string;
  review_token?: string;
  current_effective_policy_hash?: string;
  candidate_effective_policy_hash?: string;
  current_effective_policy?: SandboxPolicy;
  candidate_effective_policy?: SandboxPolicy;
}

export interface GetDraftPolicyResponse {
  chunks?: PolicyChunk[];
  rolling_summary?: string;
  draft_version?: string;
  last_analyzed_at_ms?: string;
}

export interface ApproveDraftChunkResponse {
  policy_version?: number;
  policy_hash?: string;
}

export interface ApproveAllDraftChunksResponse {
  policy_version?: number;
  policy_hash?: string;
  chunks_approved?: number;
  chunks_skipped?: number;
}

export interface UndoDraftChunkResponse {
  policy_version?: number;
  policy_hash?: string;
}

export interface ClearDraftChunksResponse {
  chunks_cleared?: number;
}

export interface DraftHistoryEntry {
  timestamp_ms?: string;
  event_type?: string; // denial_detected | analysis_cycle | approved | rejected | edited | undone | cleared
  description?: string;
  chunk_id?: string;
}

export interface GetDraftHistoryResponse {
  entries?: DraftHistoryEntry[];
}

export interface DraftChunkApproval {
  chunk_id: string;
  review_token: string;
}

export interface SandboxPolicyRevision {
  version?: number;
  policy_hash?: string;
  status?: string; // PolicyStatus enum as string
  load_error?: string;
  created_at_ms?: string;
  loaded_at_ms?: string;
  policy?: SandboxPolicy;
  provenance?: Record<string, string>;
}

export interface GetSandboxPolicyStatusResponse {
  revision?: SandboxPolicyRevision;
  active_version?: number;
}

export interface ListSandboxesResponse {
  sandboxes?: Sandbox[];
  [k: string]: unknown;
}

export interface SandboxResponse {
  sandbox?: Sandbox;
}

// Normalized view: sandbox identity lives in metadata, NOT spec.
export interface NormalizedSandbox {
  id: string;
  name: string;
  workspace: string;
  phase: string;
  raw: Sandbox;
}

// ---------------------------------------------------------------------------
// Proto location: robust across `tsx` (runs from src/) and compiled dist/src/.
// ---------------------------------------------------------------------------
function resolveProtoDir(): string {
  const candidates = [
    process.env.OPENSHELL_PROTO_DIR,
    join(__dirname, "..", "proto"), // tsx: src/../proto
    join(__dirname, "..", "..", "proto"), // dist/src/../../proto
    join(process.cwd(), "proto"),
  ].filter((p): p is string => !!p);
  for (const dir of candidates) {
    if (existsSync(join(dir, "openshell.proto"))) return dir;
  }
  throw new Error(
    `Could not locate proto/openshell.proto. Tried: ${candidates.join(", ")}. ` +
      `Set OPENSHELL_PROTO_DIR to override.`,
  );
}

function loadService(): grpc.ServiceClientConstructor {
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
  return pkg.openshell.v1.OpenShell;
}

function buildCredentials(auth: OpenShellAuth): grpc.ChannelCredentials {
  if (!auth.useTls) {
    // Local mock only.
    return grpc.credentials.createInsecure();
  }

  if (auth.mode === "mtls") {
    if (!auth.caCertPath || !auth.clientCertPath || !auth.clientKeyPath) {
      throw new Error("mTLS mode requires OPENSHELL_CA_CERT, OPENSHELL_CLIENT_CERT, OPENSHELL_CLIENT_KEY");
    }
    // Note grpc arg order: (rootCerts, privateKey, certChain).
    return grpc.credentials.createSsl(
      readFileSync(auth.caCertPath),
      readFileSync(auth.clientKeyPath),
      readFileSync(auth.clientCertPath),
    );
  }

  // bearer over TLS
  const rootCerts = auth.caCertPath ? readFileSync(auth.caCertPath) : null;
  const channelCreds = grpc.credentials.createSsl(rootCerts);
  const token = auth.bearerToken!;
  const callCreds = grpc.credentials.createFromMetadataGenerator((_params, cb) => {
    const md = new grpc.Metadata();
    md.add("authorization", `Bearer ${token}`);
    cb(null, md);
  });
  return grpc.credentials.combineChannelCredentials(channelCreds, callCreds);
}

export function isFailedPrecondition(err: unknown): boolean {
  return (err as grpc.ServiceError)?.code === grpc.status.FAILED_PRECONDITION;
}

export function isAborted(err: unknown): boolean {
  return (err as grpc.ServiceError)?.code === grpc.status.ABORTED;
}

export function isNotFound(err: unknown): boolean {
  return (err as grpc.ServiceError)?.code === grpc.status.NOT_FOUND;
}

export class OpenShellClient {
  private client: grpc.Client & Record<string, (...args: unknown[]) => unknown>;
  private defaultWorkspace: string;

  constructor(gatewayUrl: string, auth: OpenShellAuth, defaultWorkspace = "default") {
    const Ctor = loadService();
    const creds = buildCredentials(auth);
    const options: grpc.ChannelOptions = {};
    if (auth.serverName) {
      options["grpc.ssl_target_name_override"] = auth.serverName;
      options["grpc.default_authority"] = auth.serverName;
    }
    this.client = new Ctor(gatewayUrl, creds, options) as typeof this.client;
    this.defaultWorkspace = defaultWorkspace;
    log.info({ gatewayUrl, authMode: auth.mode, useTls: auth.useTls }, "OpenShell client constructed.");
  }

  private unary<TRes>(method: string, req: unknown): Promise<TRes> {
    return new Promise<TRes>((resolvePromise, reject) => {
      const fn = this.client[method];
      if (typeof fn !== "function") {
        reject(new Error(`gRPC method not found on client: ${method}`));
        return;
      }
      fn.call(this.client, req, (err: grpc.ServiceError | null, res: TRes) => {
        if (err) reject(err);
        else resolvePromise(res);
      });
    });
  }

  private ws(workspace?: string): string {
    return workspace || this.defaultWorkspace;
  }

  // --- Discovery -----------------------------------------------------------

  async listSandboxes(allWorkspaces = true): Promise<NormalizedSandbox[]> {
    const res = await this.unary<ListSandboxesResponse>("ListSandboxes", {
      all_workspaces: allWorkspaces,
    });
    return (res.sandboxes ?? []).map((s) => this.normalize(s));
  }

  async getSandbox(name: string, workspace?: string): Promise<NormalizedSandbox | undefined> {
    const res = await this.unary<SandboxResponse>("GetSandbox", {
      name,
      workspace: this.ws(workspace),
    });
    return res.sandbox ? this.normalize(res.sandbox) : undefined;
  }

  normalize(s: Sandbox): NormalizedSandbox {
    const m = s.metadata;
    return {
      id: m?.id ?? "",
      name: m?.name ?? "",
      workspace: m?.workspace ?? this.defaultWorkspace,
      phase: s.status?.phase ?? "",
      raw: s,
    };
  }

  // --- Draft policy read ---------------------------------------------------

  async getDraftPolicy(
    name: string,
    workspace?: string,
    statusFilter: "pending" | "approved" | "rejected" | "" = "pending",
  ): Promise<GetDraftPolicyResponse> {
    return this.unary<GetDraftPolicyResponse>("GetDraftPolicy", {
      name,
      status_filter: statusFilter,
      workspace: this.ws(workspace),
    });
  }

  async getDraftHistory(name: string, workspace?: string): Promise<GetDraftHistoryResponse> {
    return this.unary<GetDraftHistoryResponse>("GetDraftHistory", {
      name,
      workspace: this.ws(workspace),
    });
  }

  async getSandboxPolicyStatus(
    name: string,
    workspace?: string,
    version = 0,
  ): Promise<GetSandboxPolicyStatusResponse> {
    return this.unary<GetSandboxPolicyStatusResponse>("GetSandboxPolicyStatus", {
      name,
      version,
      global: false,
      workspace: this.ws(workspace),
    });
  }

  // --- Draft mutations (require review_token / workspace) ------------------

  async approveDraftChunk(
    name: string,
    chunkId: string,
    reviewToken: string,
    workspace?: string,
  ): Promise<ApproveDraftChunkResponse> {
    return this.unary<ApproveDraftChunkResponse>("ApproveDraftChunk", {
      name,
      chunk_id: chunkId,
      workspace: this.ws(workspace),
      review_token: reviewToken,
    });
  }

  async rejectDraftChunk(
    name: string,
    chunkId: string,
    reason: string,
    workspace?: string,
  ): Promise<void> {
    await this.unary<Record<string, never>>("RejectDraftChunk", {
      name,
      chunk_id: chunkId,
      reason,
      workspace: this.ws(workspace),
    });
  }

  async approveAllDraftChunks(
    name: string,
    approvals: DraftChunkApproval[],
    includeSecurityFlagged = false,
    workspace?: string,
  ): Promise<ApproveAllDraftChunksResponse> {
    return this.unary<ApproveAllDraftChunksResponse>("ApproveAllDraftChunks", {
      name,
      include_security_flagged: includeSecurityFlagged,
      workspace: this.ws(workspace),
      approvals,
    });
  }

  async editDraftChunk(
    name: string,
    chunkId: string,
    proposedRule: NetworkPolicyRule,
    workspace?: string,
  ): Promise<void> {
    await this.unary<Record<string, never>>("EditDraftChunk", {
      name,
      chunk_id: chunkId,
      proposed_rule: proposedRule,
      workspace: this.ws(workspace),
    });
  }

  async undoDraftChunk(
    name: string,
    chunkId: string,
    workspace?: string,
  ): Promise<UndoDraftChunkResponse> {
    return this.unary<UndoDraftChunkResponse>("UndoDraftChunk", {
      name,
      chunk_id: chunkId,
      workspace: this.ws(workspace),
    });
  }

  async clearDraftChunks(name: string, workspace?: string): Promise<ClearDraftChunksResponse> {
    return this.unary<ClearDraftChunksResponse>("ClearDraftChunks", {
      name,
      workspace: this.ws(workspace),
    });
  }

  // --- Optional per-sandbox status stream (WATCH_MODE=observe) -------------
  // Returns the raw server stream; the caller attaches "data"/"error"/"end".
  // Note: id is the sandbox ID (metadata.id), not the name.
  watchSandbox(sandboxId: string): grpc.ClientReadableStream<unknown> {
    const fn = this.client["WatchSandbox"] as (req: unknown) => grpc.ClientReadableStream<unknown>;
    return fn.call(this.client, {
      id: sandboxId,
      follow_status: true,
      follow_logs: false,
      follow_events: true,
      stop_on_terminal: true,
    });
  }

  close(): void {
    this.client.close();
  }
}
