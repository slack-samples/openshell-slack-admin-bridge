import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { childLogger } from "./logger";

const log = childLogger("config");

export type AdminRole = "super_admin" | "admin";

export interface Admin {
  slack_user_id: string;
  name: string;
  role: AdminRole;
}

export type AuthMode = "mtls" | "bearer";
export type WatchMode = "off" | "observe";

// Capture all OpenShell audit events into a private Slack channel.
// This is an independent firehose to its own channel; it does NO dedup against
// the approve/reject side (approval-outcome events may appear in both, which is
// acceptable). Ingestion supports two sources, either or both:
//   "file" = tail the OCSF JSONL file OpenShell writes locally. This is the
//            native path: OpenShell emits OCSF as line-delimited JSON to a
//            rolling file (shipped onward by external tooling), NOT as a
//            CloudEvents HTTP push. No auth; the sink must be able to read it.
//   "http" = an inbound HTTP receiver an external log-shipper (or a CloudEvents
//            producer) POSTs to. Auth is a shared bearer token we require.
// Empty `sources` = off; only the approve/reject poller runs.
export type CaptureSource = "file" | "http";

export interface CaptureConfig {
  // Enabled ingestion sources; empty means capture is off.
  sources: CaptureSource[];
  // File source (populated + required when `sources` includes "file"): a path or
  // glob to the OCSF JSONL file(s). The tailer follows appends, handles rotation,
  // and persists its byte offset to offsetStatePath so restarts resume cleanly.
  filePath?: string;
  offsetStatePath?: string;
  // HTTP receiver source (populated + required when `sources` includes "http").
  receiverBind?: string;
  receiverToken?: string;
  receiverTlsCertPath?: string;
  receiverTlsKeyPath?: string;
  // Optional noise filter. Empty (the default) captures everything, which is the
  // goal. Each entry is matched against an event's CloudEvents `type` and its
  // OCSF `class_name` / `type_name`; a match drops the event before posting.
  excludeEventTypes: string[];
  // Path to the audit-activity summary the capture sink writes and the bridge
  // reads to render App Home charts. Chart-scoped, NOT source-scoped: resolved
  // unconditionally (default ./state/audit-summary.json) because the bridge is a
  // separate process that usually has no capture sources of its own yet still
  // needs the path to read the file the capture process writes.
  summaryStatePath: string;
}

export interface OpenShellAuth {
  mode: AuthMode;
  useTls: boolean;
  serverName?: string;
  // mTLS bundle
  caCertPath?: string;
  clientCertPath?: string;
  clientKeyPath?: string;
  // Bearer
  bearerToken?: string;
}

export interface AppConfig {
  slack: {
    botToken: string;
    appToken: string;
  };
  openshell: {
    gatewayUrl: string;
    auth: OpenShellAuth;
  };
  admins: Admin[];
  routing: {
    defaultChannel: string;
    workspaceChannels: Record<string, string>;
    // Distinct channel for captured audit events. Optional: capture always
    // ingests and updates the summary that feeds App Home; setting this opts INTO
    // posting the audit firehose to Slack. Validated at load to differ from every
    // approval channel when set. Undefined leaves audit posting disabled.
    auditChannel?: string;
  };
  settings: {
    rejectReasonRequired: boolean;
    destructiveRoles: AdminRole[];
  };
  defaultWorkspace: string;
  pollIntervalMs: number;
  // Max GetDraftPolicy RPCs issued in parallel per poll cycle. Higher values keep the
  // per-cycle wall-clock flat as the sandbox count grows (POLL_CONCURRENCY).
  pollConcurrency: number;
  watchMode: WatchMode;
  capture: CaptureConfig;
  statePath: string;
  // Optional retention for terminal (approved/rejected/closed) records: prune any older
  // than this many days at startup and periodically. Undefined = keep forever (default).
  stateRetentionDays?: number;
  logLevel: string;
}

interface RawYaml {
  admins?: Admin[];
  routing?: {
    default_channel?: string;
    workspace_channels?: Record<string, string>;
    audit_channel?: string;
  };
  settings?: {
    reject_reason_required?: boolean;
    destructive_roles?: AdminRole[];
  };
  capture?: {
    exclude_event_types?: string[];
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

// Expand a single leading ${HOME} / $HOME so the example paths in .env work.
function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  const home = process.env.HOME || "";
  return p.replace(/\$\{HOME\}|\$HOME/g, home);
}

function loadAuth(): OpenShellAuth {
  const mode = (process.env.OPENSHELL_AUTH_MODE || "mtls") as AuthMode;
  if (mode !== "mtls" && mode !== "bearer") {
    throw new Error(`OPENSHELL_AUTH_MODE must be "mtls" or "bearer", got "${mode}"`);
  }
  const useTls = (process.env.OPENSHELL_USE_TLS ?? "true").toLowerCase() !== "false";

  if (mode === "mtls") {
    return {
      mode,
      useTls,
      serverName: process.env.OPENSHELL_SERVER_NAME || undefined,
      caCertPath: expandHome(process.env.OPENSHELL_CA_CERT),
      clientCertPath: expandHome(process.env.OPENSHELL_CLIENT_CERT),
      clientKeyPath: expandHome(process.env.OPENSHELL_CLIENT_KEY),
    };
  }

  // bearer: token may be inline or in a file (file wins).
  let bearerToken = process.env.OPENSHELL_BEARER_TOKEN || undefined;
  const tokenFile = expandHome(process.env.OPENSHELL_BEARER_TOKEN_FILE);
  if (tokenFile) {
    bearerToken = readFileSync(tokenFile, "utf8").trim();
  }
  if (!bearerToken) {
    throw new Error(
      "OPENSHELL_AUTH_MODE=bearer requires OPENSHELL_BEARER_TOKEN or OPENSHELL_BEARER_TOKEN_FILE",
    );
  }
  return {
    mode,
    useTls,
    serverName: process.env.OPENSHELL_SERVER_NAME || undefined,
    caCertPath: expandHome(process.env.OPENSHELL_CA_CERT),
    bearerToken,
  };
}

// POLL_CONCURRENCY: max GetDraftPolicy RPCs in flight per cycle. Unset/empty/0/NaN =>
// default 25; a non-finite value (e.g. "Infinity") also falls back to the default so it
// cannot silently defeat the bound; anything else is floored and clamped to >= 1.
function parsePollConcurrency(raw: string | undefined): number {
  const n = Number(raw) || 25;
  if (!Number.isFinite(n)) return 25;
  return Math.max(1, Math.floor(n));
}

// STATE_RETENTION_DAYS: unset/empty = keep terminal records forever (default). When
// set it must be a positive number of days; anything else is a misconfiguration we
// fail loud on rather than silently ignoring (which would leave state growing).
function parseRetentionDays(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`STATE_RETENTION_DAYS must be a positive number of days if set, got "${raw}"`);
  }
  return n;
}

// The audit-activity summary path is chart-scoped, not source-scoped: the bridge reads it to
// render App Home charts even when THIS process has no capture sources (bridge and capture are
// separate processes), and demo seeders write it directly. Resolved from CAPTURE_SUMMARY_STATE, or
// ./state/audit-summary.json by default. Exported so every writer/reader derives the one path.
export function resolveSummaryStatePath(): string {
  return resolve(expandHome(process.env.CAPTURE_SUMMARY_STATE) || "./state/audit-summary.json");
}

function parseSources(raw: string | undefined): CaptureSource[] {
  if (!raw) return [];
  const out: CaptureSource[] = [];
  for (const tok of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (tok !== "file" && tok !== "http") {
      throw new Error(`CAPTURE_SOURCES entries must be "file" or "http", got "${tok}"`);
    }
    if (!out.includes(tok)) out.push(tok);
  }
  return out;
}

function loadCapture(raw: RawYaml, routing: AppConfig["routing"], configPath: string): CaptureConfig {
  const sources = parseSources(process.env.CAPTURE_SOURCES);

  // The optional noise filter comes from YAML and applies regardless of source;
  // it carries through unchanged so every source reads it from one place.
  // Default empty = capture everything.
  const excludeEventTypes = raw.capture?.exclude_event_types ?? [];

  // The audit-activity summary path is chart-scoped, not source-scoped: the
  // bridge reads it to render App Home charts even when THIS process has no
  // capture sources (bridge and capture are separate processes), so resolve it
  // unconditionally, before the sources-empty early return.
  const summaryStatePath = resolveSummaryStatePath();

  if (sources.length === 0) {
    return { sources, excludeEventTypes, summaryStatePath };
  }

  // audit_channel is OPTIONAL: capture always ingests and updates the summary
  // that feeds App Home; posting the audit firehose to Slack is opt-in, enabled
  // only by setting routing.audit_channel. When it IS set, a misrouted channel
  // must never dump the firehose into an approval channel, so reject any overlap
  // with default_channel or workspace_channels.
  const auditChannel = routing.auditChannel;
  if (auditChannel) {
    const approvalChannels = new Set<string>([
      routing.defaultChannel,
      ...Object.values(routing.workspaceChannels),
    ]);
    if (approvalChannels.has(auditChannel)) {
      throw new Error(
        `routing.audit_channel (${auditChannel}) must not equal any approval channel ` +
          `(routing.default_channel or routing.workspace_channels) in ${configPath}`,
      );
    }
  }

  const capture: CaptureConfig = { sources, excludeEventTypes, summaryStatePath };

  if (sources.includes("file")) {
    // The path is required (not defaulted): OpenShell's OCSF log location is a
    // deployment fact the operator must point us at (co-located file, mounted
    // volume, or a centrally aggregated copy). A glob may match several files.
    const filePath = expandHome(process.env.CAPTURE_FILE_PATH);
    if (!filePath) {
      throw new Error('CAPTURE_SOURCES includes "file" but CAPTURE_FILE_PATH is not set');
    }
    capture.filePath = filePath;
    capture.offsetStatePath = resolve(
      expandHome(process.env.CAPTURE_FILE_OFFSET_STATE) || "./state/capture-offsets.json",
    );
  }

  if (sources.includes("http")) {
    // Receiver bearer: token may be inline or in a file (file wins), same idiom
    // as the OpenShell bearer above.
    let receiverToken = process.env.CAPTURE_RECEIVER_TOKEN || undefined;
    const tokenFile = expandHome(process.env.CAPTURE_RECEIVER_TOKEN_FILE);
    if (tokenFile) {
      receiverToken = readFileSync(tokenFile, "utf8").trim();
    }
    if (!receiverToken) {
      throw new Error(
        'CAPTURE_SOURCES includes "http" but neither CAPTURE_RECEIVER_TOKEN nor CAPTURE_RECEIVER_TOKEN_FILE is set',
      );
    }
    capture.receiverToken = receiverToken;
    capture.receiverBind = process.env.CAPTURE_RECEIVER_BIND || "0.0.0.0:8090";
    capture.receiverTlsCertPath = expandHome(process.env.CAPTURE_RECEIVER_TLS_CERT);
    capture.receiverTlsKeyPath = expandHome(process.env.CAPTURE_RECEIVER_TLS_KEY);
    // TLS is both-or-neither. Setting only one path would silently fall back to
    // plaintext HTTP and send the bearer token in the clear — fail loud instead
    // so a typo'd/omitted key can't quietly downgrade the listener. (Both unset
    // is a valid plaintext mode behind a TLS-terminating proxy or trusted net.)
    if (Boolean(capture.receiverTlsCertPath) !== Boolean(capture.receiverTlsKeyPath)) {
      throw new Error(
        "CAPTURE_RECEIVER_TLS_CERT and CAPTURE_RECEIVER_TLS_KEY must be set together " +
          "(or both left unset for plaintext behind a TLS-terminating proxy)",
      );
    }
  }

  return capture;
}

export function loadConfig(): AppConfig {
  const configPath = resolve(process.env.CONFIG_PATH || "./config/admins.yaml");
  let raw: RawYaml = {};
  try {
    raw = (parseYaml(readFileSync(configPath, "utf8")) as RawYaml) || {};
  } catch (err) {
    throw new Error(
      `Could not read config at ${configPath}: ${(err as Error).message}. ` +
        `Copy config/admins.example.yaml to config/admins.yaml.`,
    );
  }

  const admins = raw.admins ?? [];
  if (admins.length === 0) {
    log.warn("No admins configured; every approval action will be rejected as unauthorized.");
  }

  const defaultChannel = raw.routing?.default_channel;
  if (!defaultChannel) {
    throw new Error(`Config ${configPath} is missing routing.default_channel`);
  }

  const routing: AppConfig["routing"] = {
    defaultChannel,
    workspaceChannels: raw.routing?.workspace_channels ?? {},
    auditChannel: raw.routing?.audit_channel,
  };

  const config: AppConfig = {
    slack: {
      botToken: requireEnv("SLACK_BOT_TOKEN"),
      appToken: requireEnv("SLACK_APP_TOKEN"),
    },
    openshell: {
      gatewayUrl: process.env.OPENSHELL_GATEWAY_URL || "127.0.0.1:17670",
      auth: loadAuth(),
    },
    admins,
    routing,
    settings: {
      rejectReasonRequired: raw.settings?.reject_reason_required ?? true,
      destructiveRoles: raw.settings?.destructive_roles ?? ["super_admin"],
    },
    defaultWorkspace: process.env.OPENSHELL_WORKSPACE || "default",
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS || 3000),
    pollConcurrency: parsePollConcurrency(process.env.POLL_CONCURRENCY),
    watchMode: (process.env.WATCH_MODE || "off") as WatchMode,
    capture: loadCapture(raw, routing, configPath),
    statePath: resolve(process.env.STATE_STORE_PATH || "./state/bridge-state.json"),
    stateRetentionDays: parseRetentionDays(process.env.STATE_RETENTION_DAYS),
    logLevel: process.env.LOG_LEVEL || "info",
  };

  return config;
}

export function findAdmin(config: AppConfig, slackUserId: string): Admin | undefined {
  return config.admins.find((a) => a.slack_user_id === slackUserId);
}

export function isAuthorizedAdmin(config: AppConfig, slackUserId: string): boolean {
  return findAdmin(config, slackUserId) !== undefined;
}

// Destructive/batch actions (Undo, Clear, Approve-all) are gated to a subset of roles.
export function canPerformDestructive(config: AppConfig, slackUserId: string): boolean {
  const admin = findAdmin(config, slackUserId);
  if (!admin) return false;
  return config.settings.destructiveRoles.includes(admin.role);
}

// Resolve which Slack channel receives approvals for a given OpenShell workspace.
export function resolveChannel(config: AppConfig, workspace: string): string {
  return config.routing.workspaceChannels[workspace] || config.routing.defaultChannel;
}

// True when any capture source is enabled.
export function captureEnabled(config: AppConfig): boolean {
  return config.capture.sources.length > 0;
}

export function hasCaptureSource(config: AppConfig, source: CaptureSource): boolean {
  return config.capture.sources.includes(source);
}

// True when the audit firehose should be posted to Slack: opt-in via
// routing.audit_channel. Capture ingestion and the App Home summary run
// regardless of this; only Slack posting is gated.
export function shouldPostAudit(config: AppConfig): boolean {
  return Boolean(config.routing.auditChannel);
}

// Resolve the Slack channel that receives captured audit events. Only valid when
// audit posting is enabled (shouldPostAudit); throws otherwise. Distinct from the
// approval channel(s); load-time validation guarantees it differs from them when
// set.
export function resolveAuditChannel(config: AppConfig): string {
  const channel = config.routing.auditChannel;
  if (!channel) {
    throw new Error("routing.audit_channel is not configured; audit posting is disabled");
  }
  return channel;
}
