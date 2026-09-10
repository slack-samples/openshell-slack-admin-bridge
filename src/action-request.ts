import type { NetworkPolicyRule, NormalizedSandbox, PolicyChunk } from "./openshell-client";

// Currently only network-egress proposals are surfaced. The `kind` field is here so the
// Slack layer can branch later without a rewrite when other policy domains open up.
export type ActionKind = "network";

// Mechanistic == deterministic non-LLM proposal (confidence exactly 0 per PolicyChunk).
// Agent-authored == produced by the LLM analysis cycle (confidence > 0).
export type ProposerType = "mechanistic" | "agent_authored";

export interface EndpointSummary {
  host: string;
  ports: string;
  protocol: string;
  l7: string; // brief L7 rule note, or "" if none
}

export interface ActionRequest {
  kind: ActionKind;
  chunkId: string;
  status: string;
  stage?: string;

  sandboxId: string;
  sandboxName: string;
  workspace: string;

  reviewToken: string;

  ruleName: string;
  proposedRule?: NetworkPolicyRule;
  endpoints: EndpointSummary[];
  binaries: string[];

  rationale: string;
  securityNotes: string;
  validationResult: string;
  confidence: number;
  proposerType: ProposerType;
  securityFlagged: boolean;

  hitCount: number;
  denialCount: number;
  supersedesChunkId?: string;
}

function summarizeEndpoints(rule?: NetworkPolicyRule): EndpointSummary[] {
  if (!rule?.endpoints?.length) return [];
  return rule.endpoints.map((e) => {
    // Proto contract: when both are set, `ports` takes precedence over the scalar `port`.
    const portList: string[] = [];
    if (e.ports?.length) {
      portList.push(...e.ports.map((p) => `${p}`));
    } else if (e.port !== undefined && e.port !== null && `${e.port}` !== "0") {
      portList.push(`${e.port}`);
    }
    const l7 =
      e.rules && e.rules.length
        ? e.rules
            .map((r) => [r.method, r.path].filter(Boolean).join(" "))
            .filter(Boolean)
            .join(", ")
        : "";
    return {
      host: e.host || (e.allowed_ips?.length ? e.allowed_ips.join(", ") : "(any host)"),
      ports: portList.length ? portList.join(", ") : "(any)",
      protocol: e.protocol || "tcp",
      l7,
    };
  });
}

// A chunk is "security flagged" when the analysis attached security notes; these are
// excluded from batch approve-all unless explicitly included.
export function isSecurityFlagged(chunk: PolicyChunk): boolean {
  return !!(chunk.security_notes && chunk.security_notes.trim().length > 0);
}

export function toActionRequest(
  chunk: PolicyChunk,
  sandbox: Pick<NormalizedSandbox, "id" | "name" | "workspace">,
): ActionRequest {
  const confidence = chunk.confidence ?? 0;
  return {
    kind: "network",
    chunkId: chunk.id,
    status: chunk.status,
    stage: chunk.stage,
    sandboxId: sandbox.id,
    sandboxName: sandbox.name,
    workspace: sandbox.workspace,
    reviewToken: chunk.review_token ?? "",
    ruleName: chunk.rule_name || chunk.proposed_rule?.name || "(unnamed rule)",
    proposedRule: chunk.proposed_rule,
    endpoints: summarizeEndpoints(chunk.proposed_rule),
    binaries: (chunk.proposed_rule?.binaries ?? []).map((b) => b.path || "").filter(Boolean),
    rationale: chunk.rationale || "",
    securityNotes: chunk.security_notes || "",
    validationResult: chunk.validation_result || "",
    confidence,
    proposerType: confidence === 0 ? "mechanistic" : "agent_authored",
    securityFlagged: isSecurityFlagged(chunk),
    hitCount: chunk.hit_count ?? 0,
    denialCount: chunk.denial_summary_ids?.length ?? 0,
    supersedesChunkId: chunk.supersedes_chunk_id || undefined,
  };
}
