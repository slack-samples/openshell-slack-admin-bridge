import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_APPROVE,
  ACTION_REJECT,
  approveValue,
  buildApprovalBlocks,
  buildTerminalBlocks,
  buildRejectModal,
  parseRejectMetadata,
} from "../src/slack-messages";
import type { ActionRequest } from "../src/action-request";

// GA Block Kit surface types (no card/carousel primitives).
const GA_BLOCK_TYPES = new Set(["header", "section", "context", "actions", "divider", "input", "image"]);

const req: ActionRequest = {
  kind: "network",
  chunkId: "chunk-42",
  status: "pending",
  sandboxId: "sbx-1",
  sandboxName: "web-agent",
  workspace: "default",
  reviewToken: "rt-secret",
  ruleName: "allow-egress",
  endpoints: [{ host: "api.example.com", ports: "443", protocol: "tcp", l7: "" }],
  binaries: ["/usr/bin/curl"],
  rationale: "needed for the task",
  securityNotes: "",
  validationResult: "",
  confidence: 0,
  proposerType: "mechanistic",
  securityFlagged: false,
  hitCount: 3,
  denialCount: 1,
};

test("approval blocks use only GA block types", () => {
  for (const b of buildApprovalBlocks(req)) {
    assert.ok(GA_BLOCK_TYPES.has(b.type), `unexpected block type ${b.type}`);
  }
});

test("approval has exactly one actions block with approve + reject buttons", () => {
  const blocks = buildApprovalBlocks(req);
  const actions = blocks.filter((b) => b.type === "actions");
  assert.equal(actions.length, 1);
  const ids = (actions[0] as { elements: { action_id: string }[] }).elements.map((e) => e.action_id);
  assert.deepEqual(ids.sort(), [ACTION_APPROVE, ACTION_REJECT].sort());
});

test("button value carries the chunk id only (no review_token on the wire)", () => {
  assert.equal(approveValue(req), "chunk-42");
  const serialized = JSON.stringify(buildApprovalBlocks(req));
  assert.equal(serialized.includes("rt-secret"), false, "review_token must not appear in the message payload");
});

test("terminal blocks contain no action buttons", () => {
  const blocks = buildTerminalBlocks(req, { status: "approved", byUserId: "U1", policyVersion: 7 });
  assert.equal(blocks.some((b) => b.type === "actions"), false);
});

test("approve confirm text stays within Slack's 300-char limit for long sandbox names", () => {
  const longName = "x".repeat(253); // K8s object names can reach 253 chars
  const blocks = buildApprovalBlocks({ ...req, sandboxName: longName });
  const actions = blocks.find((b) => b.type === "actions") as { elements: { confirm?: { text: { text: string } } }[] };
  const approve = actions.elements.find((e) => e.confirm);
  assert.ok(approve?.confirm);
  assert.ok(approve.confirm.text.text.length <= 300, `confirm text was ${approve.confirm.text.text.length} chars`);
});

test("reject modal metadata carries identifiers only and round-trips", () => {
  const view = buildRejectModal({ chunkId: "chunk-42", channelId: "C1", messageTs: "123.45" }, "allow-egress", true);
  const meta = parseRejectMetadata(view.private_metadata!);
  assert.deepEqual(Object.keys(meta).sort(), ["channelId", "chunkId", "messageTs"]);
  assert.equal(meta.chunkId, "chunk-42");
  // No secrets or free-form request data smuggled into private_metadata.
  assert.equal(view.private_metadata!.includes("rt-"), false);
});
