import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";
import * as grpc from "@grpc/grpc-js";
import type { AppConfig, OpenShellAuth } from "../src/config";

// The diagnostic logger opens its destination lazily on the first diag() call, keying off
// DIAGNOSTICS_PATH. Setting it at module top (before any diag() runs, which only happens
// inside a test body) is enough to redirect the file-based test to a temp path.
const diagPath = join(tmpdir(), `bridge-diag-${process.pid}.jsonl`);
process.env.DIAGNOSTICS_PATH = diagPath;

import {
  safeError,
  chunkRef,
  checkShareSafe,
  environmentFingerprint,
  diag,
  diagStartup,
  DiagCode,
  ALLOWED_DIAG_KEYS,
} from "../src/diagnostics";

const insecureAuth: OpenShellAuth = { mode: "mtls", useTls: false };

function makeConfig(): AppConfig {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    openshell: { gatewayUrl: "gateway.internal.example:17670", auth: insecureAuth },
    admins: [
      { slack_user_id: "U1", name: "Ada Admin", role: "super_admin" },
      { slack_user_id: "U2", name: "Bo Admin", role: "admin" },
    ],
    routing: { defaultChannel: "C_SECRET", workspaceChannels: {} },
    settings: { rejectReasonRequired: true, destructiveRoles: ["super_admin"] },
    defaultWorkspace: "default",
    pollIntervalMs: 3000,
    pollConcurrency: 25,
    watchMode: "off",
    capture: { sources: [], excludeEventTypes: [], summaryStatePath: "./state/audit-summary.json" },
    statePath: "/home/somebody/state/bridge-state.json",
    logLevel: "info",
  };
}

test("safeError strips secrets and request payloads, keeping only status identifiers", () => {
  // An axios-shaped Slack error: the bot token rides in config.headers.Authorization, and the
  // message could echo request content. None of that may survive.
  const err = Object.assign(new Error("posting to #secret-channel failed: pypi.internal.corp"), {
    name: "SlackWebAPIError",
    code: 14, // grpc-style numeric would map, but this is Slack; see string-code test below
    config: { headers: { Authorization: "Bearer xoxb-0000000000000-FAKEFAKEFAKE" } },
    request: { path: "/api/chat.postMessage" },
    response: { data: { channel: "C_SECRET" } },
    stack: "Error: boom\n    at post (/Users/somebody/dev/app/src/decision-service.ts:115:20)\n    at node:internal/x:1:1",
  });

  const safe = safeError(err);
  const serialized = JSON.stringify(safe);

  assert.ok(!serialized.includes("xoxb-"), "no bot token");
  assert.ok(!serialized.includes("Authorization"), "no auth header");
  assert.ok(!serialized.toLowerCase().includes("secret-channel"), "no message content");
  assert.ok(!serialized.includes("pypi.internal.corp"), "no hostname from message");
  assert.ok(!serialized.includes("/Users/somebody"), "no absolute filesystem path");
  assert.equal(safe?.name, "SlackWebAPIError");
  // stackTop keeps only our own frame, reduced to the src-relative path.
  assert.deepEqual(safe?.stackTop, ["src/decision-service.ts:115:20"]);
});

test("safeError maps a numeric gRPC status code to its name", () => {
  const err = Object.assign(new Error("unavailable"), { code: grpc.status.UNAVAILABLE });
  const safe = safeError(err);
  assert.equal(safe?.grpcCode, grpc.status.UNAVAILABLE);
  assert.equal(safe?.grpcStatus, "UNAVAILABLE");
});

test("safeError captures the Slack error slug and string code without free text", () => {
  const err = Object.assign(new Error("An API error occurred: not_in_channel"), {
    code: "slack_webapi_platform_error",
    data: { error: "not_in_channel", response_metadata: { messages: ["quoted block value"] } },
    statusCode: 200,
  });
  const safe = safeError(err);
  assert.equal(safe?.slackError, "not_in_channel");
  assert.equal(safe?.errorCode, "slack_webapi_platform_error");
  assert.equal(safe?.httpStatus, 200);
  // response_metadata (which can quote block values) must not leak through.
  assert.ok(!JSON.stringify(safe).includes("quoted block value"));
});

test("chunkRef is a short, stable, non-reversible reference", () => {
  const a = chunkRef("chunk-1");
  const b = chunkRef("chunk-1");
  const c = chunkRef("chunk-2");
  assert.equal(a, b, "stable within a run");
  assert.notEqual(a, c, "distinct ids differ");
  assert.notEqual(a, "chunk-1", "not the raw id");
  assert.match(a!, /^[0-9a-f]{8}$/, "8 hex chars");
  assert.equal(chunkRef(undefined), undefined);
});

test("environmentFingerprint is counts/enums only, no hostname or names", () => {
  const fp = environmentFingerprint(makeConfig());
  assert.equal(fp.adminCount, 2);
  assert.equal(fp.authMode, "mtls");
  assert.equal(fp.useTls, false);
  assert.equal(fp.pollIntervalMs, 3000);
  assert.equal(fp.pollConcurrency, 25);
  const s = JSON.stringify(fp);
  assert.ok(!s.includes("Ada"), "no admin names");
  assert.ok(!s.includes("gateway.internal"), "no gateway host");
  assert.ok(!s.includes("somebody"), "no filesystem path");
});

test("checkShareSafe passes allowlisted lines and flags leaks", () => {
  const good = JSON.stringify({ level: 30, time: 1, sessionId: "s", tier: "diagnostic", code: "POST_FAILED", chunkRef: "ab12cd34", err: { grpcStatus: "UNAVAILABLE" } });
  assert.equal(checkShareSafe([good]).ok, true);

  const disallowedKey = JSON.stringify({ code: "POST_FAILED", channel: "C_SECRET" });
  const r1 = checkShareSafe([disallowedKey]);
  assert.equal(r1.ok, false);
  assert.ok(r1.violations.some((v) => v.includes("channel")), "flags the disallowed key");

  const secret = JSON.stringify({ code: "X", msg: "token is xoxb-0000000000000-abcdefghijkl" });
  const r2 = checkShareSafe([secret]);
  assert.equal(r2.ok, false);
  assert.ok(r2.violations.some((v) => v.includes("secret pattern")), "flags the token");

  const notJson = "this is not json";
  assert.equal(checkShareSafe([notJson]).ok, false);
});

test("diag() and diagStartup() write only share-safe lines to the diagnostics file", () => {
  try {
    diagStartup(makeConfig());
    diag(DiagCode.PostFailed, {
      chunkRef: chunkRef("chunk-1"),
      err: safeError(Object.assign(new Error("boom"), { code: grpc.status.UNAVAILABLE })),
    });
    diag(DiagCode.StaleReviewToken, { chunkRef: chunkRef("chunk-2"), retry: 1 });

    const lines = readFileSync(diagPath, "utf8").split("\n").filter((l) => l.trim() !== "");
    assert.ok(lines.length >= 3, "wrote a line per diag call");

    // The whole file must pass the same gate the support bundle uses.
    const result = checkShareSafe(lines);
    assert.deepEqual(result.violations, [], "no share-safety violations");
    assert.equal(result.ok, true);

    // The startup fingerprint and a mapped gRPC status are present and correct.
    const parsed = lines.map((l) => JSON.parse(l));
    assert.ok(parsed.some((p) => p.code === DiagCode.Startup && p.env?.adminCount === 2));
    assert.ok(parsed.some((p) => p.code === DiagCode.PostFailed && p.err?.grpcStatus === "UNAVAILABLE"));

    // No pino default hostname binding leaked in.
    assert.ok(!parsed.some((p) => "hostname" in p), "no hostname field");
    // Sanity: every emitted key is on the allowlist.
    for (const p of parsed) {
      for (const k of Object.keys(p)) assert.ok(ALLOWED_DIAG_KEYS.has(k), `top-level key ${k} allowed`);
    }
  } finally {
    rmSync(diagPath, { force: true });
  }
});
