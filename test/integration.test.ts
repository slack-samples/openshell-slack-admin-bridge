import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMockServer, type MockServerHandle } from "../src/mock-server";
import { OpenShellClient, isFailedPrecondition } from "../src/openshell-client";
import type { OpenShellAuth } from "../src/config";

// End-to-end over a real gRPC socket: proves proto loading and field mapping against
// the current schema (identity from metadata, review_token on approve).
let handle: MockServerHandle;
let client: OpenShellClient;

const insecureAuth: OpenShellAuth = { mode: "mtls", useTls: false };

before(async () => {
  handle = await startMockServer("127.0.0.1:0");
  client = new OpenShellClient(`127.0.0.1:${handle.port}`, insecureAuth, "default");
});

after(() => {
  client.close();
  handle.close();
});

test("listSandboxes reads identity from metadata, not spec", async () => {
  const sandboxes = await client.listSandboxes(true);
  assert.equal(sandboxes.length, 1);
  assert.equal(sandboxes[0].name, "web-agent");
  assert.equal(sandboxes[0].id, "sbx-001");
  assert.equal(sandboxes[0].workspace, "default");
});

test("getDraftPolicy returns pending chunks with review tokens", async () => {
  const resp = await client.getDraftPolicy("web-agent", "default", "pending");
  assert.ok((resp.chunks?.length ?? 0) >= 2);
  for (const c of resp.chunks ?? []) {
    assert.equal(c.status, "pending");
    assert.ok(c.review_token, "each chunk carries a review_token");
  }
});

test("approve with a stale review_token yields FAILED_PRECONDITION", async () => {
  const resp = await client.getDraftPolicy("web-agent", "default", "pending");
  const target = resp.chunks![0];
  await assert.rejects(
    () => client.approveDraftChunk("web-agent", target.id, "wrong-token", "default"),
    (err: unknown) => isFailedPrecondition(err),
  );
});

test("approve with the correct review_token succeeds and bumps policy version", async () => {
  const resp = await client.getDraftPolicy("web-agent", "default", "pending");
  const target = resp.chunks![0];
  const res = await client.approveDraftChunk("web-agent", target.id, target.review_token!, "default");
  assert.ok((res.policy_version ?? 0) >= 2);

  // The approved chunk no longer appears in the pending set.
  const after = await client.getDraftPolicy("web-agent", "default", "pending");
  assert.equal(after.chunks?.some((c) => c.id === target.id), false);
});

test("reject removes the chunk from pending", async () => {
  const resp = await client.getDraftPolicy("web-agent", "default", "pending");
  const target = resp.chunks![0];
  await client.rejectDraftChunk("web-agent", target.id, "not trusted", "default");
  const after = await client.getDraftPolicy("web-agent", "default", "pending");
  assert.equal(after.chunks?.some((c) => c.id === target.id), false);
});
