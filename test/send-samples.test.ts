import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

test("sample seeding authenticates the requested sandbox using its token file", async () => {
  const root = process.cwd();
  const dir = mkdtempSync(join(tmpdir(), "sample-auth-test-"));
  const tokenFile = join(dir, "sandbox.jwt");
  writeFileSync(tokenFile, "test-sandbox-token\n", { mode: 0o600 });
  const def = protoLoader.loadSync(join(root, "proto/openshell.proto"), {
    keepCase: true, includeDirs: [join(root, "proto")],
  });
  const pkg = grpc.loadPackageDefinition(def) as any;
  const server = new grpc.Server();
  let accepted = false;
  server.addService(pkg.openshell.v1.OpenShell.service, {
    SubmitPolicyAnalysis: (call: any, callback: any) => {
      if (call.metadata.get("authorization")[0] !== "Bearer test-sandbox-token") {
        callback({ code: grpc.status.UNAUTHENTICATED, message: "sandbox identity missing" });
        return;
      }
      accepted = call.request.name === "slack-repair-0913" && call.request.proposed_chunks.length === 3;
      callback(null, { accepted_chunks: 3, accepted_chunk_ids: ["a", "b", "c"] });
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync("127.0.0.1:0",
    grpc.ServerCredentials.createInsecure(), (err, port) => err ? reject(err) : resolve(port)));
  try {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/send-samples.ts"], {
      cwd: root, env: { ...process.env, MOCK_ADDR: `127.0.0.1:${port}`,
        SAMPLE_SANDBOX: "slack-repair-0913", SAMPLE_SANDBOX_TOKEN_FILE: tokenFile },
    });
    let output = "";
    child.stdout.on("data", (s) => output += s);
    child.stderr.on("data", (s) => output += s);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject); child.on("close", resolve);
    });
    assert.equal(code, 0, output);
    assert.equal(accepted, true);
    assert.ok(!output.includes("test-sandbox-token"), "token must not appear in logs");
  } finally {
    server.forceShutdown();
  }
});
