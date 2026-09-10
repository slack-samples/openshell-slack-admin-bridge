import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOcsf } from "../../src/capture/normalize";
import { buildAuditBlocks, buildAuditText, renderAudit } from "../../src/capture/blocks";

function textOf(blocks: ReturnType<typeof buildAuditBlocks>): string {
  // Flatten every renderable string in the block tree for assertions.
  const out: string[] = [];
  for (const b of blocks as any[]) {
    if (b.text?.text) out.push(b.text.text);
    for (const f of b.fields ?? []) if (f.text) out.push(f.text);
    for (const e of b.elements ?? []) if (e.text) out.push(e.text);
  }
  return out.join("\n");
}

test("buildAuditBlocks renders a header with the type name and a severity emoji", () => {
  const ev = normalizeOcsf({ class_name: "Network Activity", activity_name: "Traffic", type_name: "Network Activity: Traffic", severity_id: 3, severity: "Medium" });
  const blocks = buildAuditBlocks(ev);
  const header = blocks[0] as any;
  assert.equal(header.type, "header");
  assert.match(header.text.text, /Network Activity: Traffic/);
  assert.match(header.text.text, /:large_orange_circle:/);
});

test("buildAuditText summarizes severity, type, and message", () => {
  const ev = normalizeOcsf({ type_name: "SSH Activity: Logon", severity: "High", message: "nonce replay" });
  assert.equal(buildAuditText(ev), "High · SSH Activity: Logon: nonce replay");
});

test("untrusted message content cannot inject links or mentions", () => {
  const ev = normalizeOcsf({ class_name: "Network Activity", message: "denied <@U012ADMIN> see <http://evil|click> & <!channel>" });
  const flat = textOf(buildAuditBlocks(ev));
  assert.ok(!flat.includes("<@U012ADMIN>"), "raw mention must not survive");
  assert.ok(!flat.includes("<http://evil|click>"), "raw link must not survive");
  assert.ok(!flat.includes("<!channel>"), "raw broadcast must not survive");
  assert.match(flat, /&lt;@U012ADMIN&gt;/);
  assert.match(flat, /&amp;/);
});

test("the raw detail block neutralizes backticks so content cannot break out of the fence", () => {
  const ev = normalizeOcsf({ class_name: "Process Activity", cmd_line: "sh -c '```; echo pwn`'" });
  const flat = textOf(buildAuditBlocks(ev));
  // The only backticks in the output are the two fences (3 + 3 = 6); content
  // backticks are replaced.
  const backticks = (flat.match(/`/g) ?? []).length;
  assert.equal(backticks, 6);
});

test("no detail block is emitted when there are no class-specific fields", () => {
  const ev = normalizeOcsf({ class_name: "Base Event", severity: "Informational" });
  const flat = textOf(buildAuditBlocks(ev));
  assert.ok(!flat.includes("*Fields*"), "empty extra should not render a Fields block");
});

test("a very large message is truncated under the 3000-char section limit", () => {
  const ev = normalizeOcsf({ class_name: "Network Activity", message: "x".repeat(10000) });
  const blocks = buildAuditBlocks(ev) as any[];
  const msg = blocks.find((b) => b.text?.text?.startsWith("*Message*"));
  assert.ok(msg, "message block present");
  assert.ok(msg.text.text.length <= 3000, `section text ${msg.text.text.length} exceeds 3000`);
});

test("untrusted status_detail cannot inject markup", () => {
  const ev = normalizeOcsf({ class_name: "Process Activity", status_detail: "blocked <@U0BAD> <!here> <http://x|y>" });
  const flat = textOf(buildAuditBlocks(ev));
  assert.ok(!flat.includes("<@U0BAD>"), "raw mention must not survive");
  assert.ok(!flat.includes("<!here>"), "raw broadcast must not survive");
  assert.ok(!flat.includes("<http://x|y>"), "raw link must not survive");
  assert.match(flat, /&lt;@U0BAD&gt;/);
});

test("untrusted container/device/product values are escaped and cannot break out of code spans", () => {
  const ev = normalizeOcsf({
    class_name: "Process Activity",
    container: { name: "c`<@U0>`x", uid: "u<!channel>", image: "img<http://e|e>" },
    device: { hostname: "host<@U0DEV>" },
    metadata: { product: { name: "prod<!everyone>" }, uid: "s" },
  });
  const flat = textOf(buildAuditBlocks(ev));
  assert.ok(!flat.includes("<@U0>"), "container name mention must not survive");
  assert.ok(!flat.includes("<!channel>"), "container uid broadcast must not survive");
  assert.ok(!flat.includes("<http://e|e>"), "container image link must not survive");
  assert.ok(!flat.includes("<@U0DEV>"), "device hostname mention must not survive");
  assert.ok(!flat.includes("<!everyone>"), "product broadcast must not survive");
  // The literal backtick in the container name must not open a code span that
  // swallows the escaped mention: the only backticks are the six span delimiters
  // wrapping name/image/uid, none from content.
  const backticks = (flat.match(/`/g) ?? []).length;
  assert.equal(backticks, 6);
});

test("renderAudit returns fallback text matching buildAuditText and a header-led block list", () => {
  const ev = normalizeOcsf({ type_name: "API Activity: Create", severity: "Low" });
  const r = renderAudit(ev);
  assert.equal(r.text, buildAuditText(ev));
  assert.ok(Array.isArray(r.blocks) && r.blocks.length > 0);
  assert.equal(r.blocks[0].type, "header");
});
