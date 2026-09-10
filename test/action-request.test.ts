import { test } from "node:test";
import assert from "node:assert/strict";
import { toActionRequest, isSecurityFlagged } from "../src/action-request";
import type { PolicyChunk } from "../src/openshell-client";

const sandbox = { id: "sbx-1", name: "web-agent", workspace: "default" };

function chunk(overrides: Partial<PolicyChunk>): PolicyChunk {
  return {
    id: "c1",
    status: "pending",
    rule_name: "allow-egress",
    proposed_rule: {
      name: "allow-egress",
      endpoints: [{ host: "api.example.com", ports: [443], protocol: "tcp" }],
      binaries: [{ path: "/usr/bin/curl" }],
    },
    rationale: "needed",
    confidence: 0,
    review_token: "rt-1",
    ...overrides,
  };
}

test("confidence 0 is mechanistic, > 0 is agent-authored", () => {
  assert.equal(toActionRequest(chunk({ confidence: 0 }), sandbox).proposerType, "mechanistic");
  assert.equal(toActionRequest(chunk({ confidence: 0.5 }), sandbox).proposerType, "agent_authored");
});

test("security notes flag a chunk", () => {
  assert.equal(isSecurityFlagged(chunk({ security_notes: "" })), false);
  assert.equal(isSecurityFlagged(chunk({ security_notes: "check this host" })), true);
  assert.equal(toActionRequest(chunk({ security_notes: "check this host" }), sandbox).securityFlagged, true);
});

test("endpoints and binaries are summarized from the proposed rule", () => {
  const req = toActionRequest(chunk({}), sandbox);
  assert.equal(req.endpoints.length, 1);
  assert.equal(req.endpoints[0].host, "api.example.com");
  assert.equal(req.endpoints[0].ports, "443");
  assert.deepEqual(req.binaries, ["/usr/bin/curl"]);
  assert.equal(req.reviewToken, "rt-1");
  assert.equal(req.sandboxName, "web-agent");
});

test("missing review_token normalizes to empty string, not undefined", () => {
  const req = toActionRequest(chunk({ review_token: undefined }), sandbox);
  assert.equal(req.reviewToken, "");
});

test("when both port and ports are set, ports wins (proto precedence)", () => {
  const req = toActionRequest(
    chunk({
      proposed_rule: {
        name: "r",
        endpoints: [{ host: "h", port: 8080, ports: [443, 8443], protocol: "tcp" }],
        binaries: [],
      },
    }),
    sandbox,
  );
  assert.equal(req.endpoints[0].ports, "443, 8443");
});

test("falls back to the scalar port when ports is empty", () => {
  const req = toActionRequest(
    chunk({
      proposed_rule: { name: "r", endpoints: [{ host: "h", port: 8080, protocol: "tcp" }], binaries: [] },
    }),
    sandbox,
  );
  assert.equal(req.endpoints[0].ports, "8080");
});
