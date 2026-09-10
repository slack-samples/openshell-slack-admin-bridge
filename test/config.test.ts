import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isAuthorizedAdmin,
  canPerformDestructive,
  findAdmin,
  resolveChannel,
  resolveAuditChannel,
  shouldPostAudit,
  loadConfig,
  type AppConfig,
} from "../src/config";

function makeConfig(): AppConfig {
  return {
    slack: { botToken: "xoxb-test", appToken: "xapp-test" },
    openshell: { gatewayUrl: "127.0.0.1:17670", auth: { mode: "mtls", useTls: false } },
    admins: [
      { slack_user_id: "U_SUPER", name: "Super", role: "super_admin" },
      { slack_user_id: "U_ADMIN", name: "Admin", role: "admin" },
    ],
    routing: {
      defaultChannel: "C_DEFAULT",
      workspaceChannels: { "team-a": "C_TEAM_A" },
    },
    settings: { rejectReasonRequired: true, destructiveRoles: ["super_admin"] },
    defaultWorkspace: "default",
    pollIntervalMs: 3000,
    pollConcurrency: 25,
    watchMode: "off",
    capture: {
      sources: [],
      excludeEventTypes: [],
      summaryStatePath: "./state/audit-summary.json",
    },
    statePath: "./state/x.json",
    logLevel: "info",
  };
}

test("only listed admins are authorized", () => {
  const c = makeConfig();
  assert.equal(isAuthorizedAdmin(c, "U_SUPER"), true);
  assert.equal(isAuthorizedAdmin(c, "U_ADMIN"), true);
  assert.equal(isAuthorizedAdmin(c, "U_STRANGER"), false);
});

test("destructive actions are gated by role", () => {
  const c = makeConfig();
  assert.equal(canPerformDestructive(c, "U_SUPER"), true);
  assert.equal(canPerformDestructive(c, "U_ADMIN"), false);
  assert.equal(canPerformDestructive(c, "U_STRANGER"), false);
});

test("channel routing falls back to the default channel", () => {
  const c = makeConfig();
  assert.equal(resolveChannel(c, "team-a"), "C_TEAM_A");
  assert.equal(resolveChannel(c, "default"), "C_DEFAULT");
  assert.equal(resolveChannel(c, "unmapped"), "C_DEFAULT");
});

test("findAdmin returns the role for identity lookup", () => {
  const c = makeConfig();
  assert.equal(findAdmin(c, "U_ADMIN")?.role, "admin");
  assert.equal(findAdmin(c, "U_STRANGER"), undefined);
});

// ---- Capture config -----------------------------------------------------
// These exercise the real loadConfig() path against a throwaway YAML file and
// a controlled environment. Env keys the loader consults are cleared first so
// a developer's shell cannot leak in, and restored afterward.

const MANAGED_ENV = [
  "CONFIG_PATH",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "OPENSHELL_AUTH_MODE",
  "OPENSHELL_BEARER_TOKEN",
  "OPENSHELL_BEARER_TOKEN_FILE",
  "POLL_CONCURRENCY",
  "STATE_RETENTION_DAYS",
  "CAPTURE_SOURCES",
  "CAPTURE_FILE_PATH",
  "CAPTURE_FILE_OFFSET_STATE",
  "CAPTURE_RECEIVER_BIND",
  "CAPTURE_RECEIVER_TOKEN",
  "CAPTURE_RECEIVER_TOKEN_FILE",
  "CAPTURE_RECEIVER_TLS_CERT",
  "CAPTURE_RECEIVER_TLS_KEY",
  "CAPTURE_SUMMARY_STATE",
];

// Assemble a minimal valid config YAML. auditChannel nests under routing;
// captureBlock is a top-level block appended verbatim.
function cfgYaml(opts: { auditChannel?: string; captureBlock?: string } = {}): string {
  const lines = [
    "admins:",
    "  - { slack_user_id: U_SUPER, name: Super, role: super_admin }",
    "routing:",
    "  default_channel: C_DEFAULT",
    "  workspace_channels:",
    "    team-a: C_TEAM_A",
  ];
  if (opts.auditChannel) lines.push(`  audit_channel: ${opts.auditChannel}`);
  if (opts.captureBlock) lines.push(opts.captureBlock);
  return lines.join("\n") + "\n";
}

function withConfig<T>(
  setup: (dir: string) => { yaml: string; env?: Record<string, string> },
  run: (load: () => AppConfig) => T,
): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of MANAGED_ENV) saved[k] = process.env[k];
  const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-"));
  try {
    const { yaml, env = {} } = setup(dir);
    const cfgPath = join(dir, "admins.yaml");
    writeFileSync(cfgPath, yaml, "utf8");
    for (const k of MANAGED_ENV) delete process.env[k];
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.CONFIG_PATH = cfgPath;
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    return run(() => loadConfig());
  } finally {
    for (const k of MANAGED_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("capture defaults to off (empty sources) and captures everything", () => {
  const c = withConfig(() => ({ yaml: cfgYaml() }), (load) => load());
  assert.deepEqual(c.capture.sources, []);
  assert.deepEqual(c.capture.excludeEventTypes, []);
  assert.equal(c.capture.filePath, undefined);
  assert.equal(c.capture.receiverToken, undefined);
  assert.equal(c.routing.auditChannel, undefined);
  assert.equal(shouldPostAudit(c), false);
  // The audit-summary path is resolved even with no sources: the bridge (a separate process,
  // usually with no capture sources of its own) reads it to render App Home charts.
  assert.match(c.capture.summaryStatePath, /audit-summary\.json$/);
});

test("CAPTURE_SUMMARY_STATE overrides the audit-summary path", () => {
  const c = withConfig(
    () => ({ yaml: cfgYaml(), env: { CAPTURE_SUMMARY_STATE: "/data/audit.json" } }),
    (load) => load(),
  );
  assert.equal(c.capture.summaryStatePath, "/data/audit.json");
});

test("an unknown CAPTURE_SOURCES entry is rejected", () => {
  withConfig(
    () => ({ yaml: cfgYaml(), env: { CAPTURE_SOURCES: "sink" } }),
    (load) => assert.throws(load, /must be "file" or "http"/),
  );
});

test("CAPTURE_SOURCES entries are trimmed and de-duplicated", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: { CAPTURE_SOURCES: " file , file ", CAPTURE_FILE_PATH: "/var/log/ocsf.log" },
    }),
    (load) => load(),
  );
  assert.deepEqual(c.capture.sources, ["file"]);
});

test("the exclude filter can be overridden from YAML", () => {
  const captureBlock = "capture:\n  exclude_event_types: [Process Activity, HTTP Activity]";
  const c = withConfig(() => ({ yaml: cfgYaml({ captureBlock }) }), (load) => load());
  assert.deepEqual(c.capture.excludeEventTypes, ["Process Activity", "HTTP Activity"]);
});

test("a capture source WITHOUT routing.audit_channel is allowed (Slack posting is opt-in)", () => {
  // Capture always ingests and writes the App Home summary; posting to Slack is opt-in via
  // audit_channel, so a source with no channel must load cleanly rather than throw.
  const c = withConfig(
    () => ({ yaml: cfgYaml(), env: { CAPTURE_SOURCES: "file", CAPTURE_FILE_PATH: "/var/log/ocsf.log" } }),
    (load) => load(),
  );
  assert.deepEqual(c.capture.sources, ["file"]);
  assert.equal(c.capture.filePath, "/var/log/ocsf.log");
  assert.equal(c.routing.auditChannel, undefined);
  assert.equal(shouldPostAudit(c), false);
  assert.match(c.capture.summaryStatePath, /audit-summary\.json$/);
});

test("the audit channel may not equal the default approval channel", () => {
  withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_DEFAULT" }),
      env: { CAPTURE_SOURCES: "file", CAPTURE_FILE_PATH: "/var/log/ocsf.log" },
    }),
    (load) => assert.throws(load, /must not equal any approval channel/),
  );
});

test("the audit channel may not equal a workspace approval channel", () => {
  withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_TEAM_A" }),
      env: { CAPTURE_SOURCES: "file", CAPTURE_FILE_PATH: "/var/log/ocsf.log" },
    }),
    (load) => assert.throws(load, /must not equal any approval channel/),
  );
});

test('CAPTURE_SOURCES=file requires CAPTURE_FILE_PATH', () => {
  withConfig(
    () => ({ yaml: cfgYaml({ auditChannel: "C_AUDIT" }), env: { CAPTURE_SOURCES: "file" } }),
    (load) => assert.throws(load, /CAPTURE_FILE_PATH is not set/),
  );
});

test("CAPTURE_SOURCES=file loads the file path and a default offset-state path", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: { CAPTURE_SOURCES: "file", CAPTURE_FILE_PATH: "/var/log/openshell-ocsf.*.log" },
    }),
    (load) => load(),
  );
  assert.deepEqual(c.capture.sources, ["file"]);
  assert.equal(c.capture.filePath, "/var/log/openshell-ocsf.*.log");
  assert.match(c.capture.offsetStatePath ?? "", /capture-offsets\.json$/);
  assert.equal(c.capture.receiverToken, undefined);
  assert.equal(resolveAuditChannel(c), "C_AUDIT");
});

test("a custom offset-state path is honored", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: {
        CAPTURE_SOURCES: "file",
        CAPTURE_FILE_PATH: "/var/log/ocsf.log",
        CAPTURE_FILE_OFFSET_STATE: "/data/offsets.json",
      },
    }),
    (load) => load(),
  );
  assert.equal(c.capture.offsetStatePath, "/data/offsets.json");
});

test('CAPTURE_SOURCES=http requires a receiver token', () => {
  withConfig(
    () => ({ yaml: cfgYaml({ auditChannel: "C_AUDIT" }), env: { CAPTURE_SOURCES: "http" } }),
    (load) => assert.throws(load, /CAPTURE_RECEIVER_TOKEN/),
  );
});

test("CAPTURE_SOURCES=http loads a distinct audit channel and receiver leg", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: { CAPTURE_SOURCES: "http", CAPTURE_RECEIVER_TOKEN: "s3cret" },
    }),
    (load) => load(),
  );
  assert.deepEqual(c.capture.sources, ["http"]);
  assert.equal(c.capture.receiverToken, "s3cret");
  assert.equal(c.capture.receiverBind, "0.0.0.0:8090");
  assert.equal(c.capture.filePath, undefined);
  assert.equal(c.routing.auditChannel, "C_AUDIT");
  assert.equal(resolveAuditChannel(c), "C_AUDIT");
});

test("both sources can be enabled together", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: {
        CAPTURE_SOURCES: "file,http",
        CAPTURE_FILE_PATH: "/var/log/ocsf.log",
        CAPTURE_RECEIVER_TOKEN: "t",
      },
    }),
    (load) => load(),
  );
  assert.deepEqual(c.capture.sources, ["file", "http"]);
  assert.equal(c.capture.filePath, "/var/log/ocsf.log");
  assert.equal(c.capture.receiverToken, "t");
});

test("a custom receiver bind address is honored", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: {
        CAPTURE_SOURCES: "http",
        CAPTURE_RECEIVER_TOKEN: "t",
        CAPTURE_RECEIVER_BIND: "127.0.0.1:9999",
      },
    }),
    (load) => load(),
  );
  assert.equal(c.capture.receiverBind, "127.0.0.1:9999");
});

test("TLS cert and key are loaded together", () => {
  const c = withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: {
        CAPTURE_SOURCES: "http",
        CAPTURE_RECEIVER_TOKEN: "t",
        CAPTURE_RECEIVER_TLS_CERT: "/etc/tls/cert.pem",
        CAPTURE_RECEIVER_TLS_KEY: "/etc/tls/key.pem",
      },
    }),
    (load) => load(),
  );
  assert.equal(c.capture.receiverTlsCertPath, "/etc/tls/cert.pem");
  assert.equal(c.capture.receiverTlsKeyPath, "/etc/tls/key.pem");
});

test("a half-configured TLS pair is rejected (would silently downgrade to plaintext)", () => {
  withConfig(
    () => ({
      yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
      env: {
        CAPTURE_SOURCES: "http",
        CAPTURE_RECEIVER_TOKEN: "t",
        CAPTURE_RECEIVER_TLS_CERT: "/etc/tls/cert.pem", // key omitted
      },
    }),
    (load) => assert.throws(load, /must be set together/),
  );
});

test("a receiver token file overrides an inline receiver token", () => {
  const c = withConfig(
    (dir) => {
      const tokenPath = join(dir, "receiver.token");
      writeFileSync(tokenPath, "from-file\n", "utf8");
      return {
        yaml: cfgYaml({ auditChannel: "C_AUDIT" }),
        env: {
          CAPTURE_SOURCES: "http",
          CAPTURE_RECEIVER_TOKEN: "inline-loses",
          CAPTURE_RECEIVER_TOKEN_FILE: tokenPath,
        },
      };
    },
    (load) => load(),
  );
  assert.equal(c.capture.receiverToken, "from-file");
});

test("resolveAuditChannel throws when no audit channel is configured; shouldPostAudit reflects it", () => {
  const c = makeConfig();
  assert.equal(shouldPostAudit(c), false);
  assert.throws(() => resolveAuditChannel(c), /audit_channel is not configured/);
});

test("shouldPostAudit is true and resolveAuditChannel returns the channel once it is set", () => {
  const c = makeConfig();
  c.routing.auditChannel = "C_AUDIT";
  assert.equal(shouldPostAudit(c), true);
  assert.equal(resolveAuditChannel(c), "C_AUDIT");
});

// ---- Poller concurrency + terminal-record retention --------------------

test("pollConcurrency defaults to 25 and retention defaults to off", () => {
  const c = withConfig(() => ({ yaml: cfgYaml() }), (load) => load());
  assert.equal(c.pollConcurrency, 25);
  assert.equal(c.stateRetentionDays, undefined);
});

test("POLL_CONCURRENCY is honored and clamped to at least 1", () => {
  const hi = withConfig(() => ({ yaml: cfgYaml(), env: { POLL_CONCURRENCY: "50" } }), (load) => load());
  assert.equal(hi.pollConcurrency, 50);
  const lo = withConfig(() => ({ yaml: cfgYaml(), env: { POLL_CONCURRENCY: "0" } }), (load) => load());
  assert.equal(lo.pollConcurrency, 25, "an invalid 0 falls back to the default");
  const neg = withConfig(() => ({ yaml: cfgYaml(), env: { POLL_CONCURRENCY: "-4" } }), (load) => load());
  assert.equal(neg.pollConcurrency, 1, "a negative value clamps to 1");
  const inf = withConfig(() => ({ yaml: cfgYaml(), env: { POLL_CONCURRENCY: "Infinity" } }), (load) => load());
  assert.equal(inf.pollConcurrency, 25, "a non-finite value cannot defeat the bound; falls back to default");
});

test("STATE_RETENTION_DAYS is parsed when set", () => {
  const c = withConfig(() => ({ yaml: cfgYaml(), env: { STATE_RETENTION_DAYS: "30" } }), (load) => load());
  assert.equal(c.stateRetentionDays, 30);
});

test("a non-positive STATE_RETENTION_DAYS is rejected (would silently disable pruning)", () => {
  withConfig(
    () => ({ yaml: cfgYaml(), env: { STATE_RETENTION_DAYS: "0" } }),
    (load) => assert.throws(load, /positive number of days/),
  );
  withConfig(
    () => ({ yaml: cfgYaml(), env: { STATE_RETENTION_DAYS: "notanumber" } }),
    (load) => assert.throws(load, /positive number of days/),
  );
});
