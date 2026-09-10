import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { startMockServer } from "../src/mock-server";
import { OpenShellClient } from "../src/openshell-client";
import type { OpenShellAuth } from "../src/config";

const insecureAuth: OpenShellAuth = { mode: "mtls", useTls: false };

// The bridge's OpenShellClient never authors proposals, so SubmitPolicyAnalysis is only
// reachable via a raw client. Build one here to exercise the gateway's assignment of ids.
function rawClient(addr: string): grpc.Client & Record<string, (...args: unknown[]) => void> {
  const def = protoLoader.loadSync("openshell.proto", {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [join(process.cwd(), "proto")],
  });
  const pkg = grpc.loadPackageDefinition(def) as unknown as {
    openshell: { v1: { OpenShell: grpc.ServiceClientConstructor } };
  };
  return new pkg.openshell.v1.OpenShell(addr, grpc.credentials.createInsecure()) as never;
}

// Regression: proto3 scalar defaults mean a submitted chunk arrives with id="" / review_token="".
// The gateway must ignore those and assign its own, or the posted approval card carries an empty
// button value and Slack rejects it with invalid_blocks.
test("SubmitPolicyAnalysis assigns a server id and review_token, ignoring client defaults", async () => {
  const handle = await startMockServer("127.0.0.1:0");
  const addr = `127.0.0.1:${handle.port}`;
  const raw = rawClient(addr);
  const reader = new OpenShellClient(addr, insecureAuth, "default");
  try {
    const submitRes = await new Promise<{ accepted_chunks?: number; accepted_chunk_ids?: string[] }>(
      (resolve, reject) => {
        raw.SubmitPolicyAnalysis(
          {
            name: "web-agent",
            analysis_mode: "mechanistic",
            workspace: "default",
            proposed_chunks: [
              {
                rule_name: "allow-test-submit",
                proposed_rule: {
                  name: "allow-test-submit",
                  endpoints: [{ host: "example.test", ports: [443], protocol: "tcp" }],
                  binaries: [{ path: "/usr/bin/curl" }],
                },
                rationale: "regression fixture",
                confidence: 0,
              },
            ],
          },
          (err: grpc.ServiceError | null, res: unknown) =>
            err ? reject(err) : resolve(res as { accepted_chunks?: number; accepted_chunk_ids?: string[] }),
        );
      },
    );

    const ids = submitRes.accepted_chunk_ids ?? [];
    assert.equal(submitRes.accepted_chunks, 1);
    assert.equal(ids.length, 1);
    assert.ok(ids[0] && ids[0].length > 0, "server assigned a non-empty chunk id");

    const pending = await reader.getDraftPolicy("web-agent", "default", "pending");
    const created = pending.chunks?.find((c) => c.id === ids[0]);
    assert.ok(created, "the submitted chunk is discoverable as pending");
    assert.ok(created!.review_token && created!.review_token.length > 0, "carries a non-empty review_token");
    assert.equal(created!.status, "pending");
  } finally {
    reader.close();
    (raw as unknown as { close: () => void }).close();
    handle.close();
  }
});
