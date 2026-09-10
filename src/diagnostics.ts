// Tier-2 "diagnostic" logging: a share-safe stream a customer can hand back to the vendor
// when they hit a bug, containing NO personal or customer-proprietary data.
//
// Design contract: this log is built from an ALLOWLIST of known-safe fields, never by
// scrubbing a rich object. Every entry is a stable error `code` plus a small, typed context
// (counts, enums, a salted chunk reference, and a redaction-safe error summary). We never log
// tokens, egress hostnames, rule text, channel/user IDs, admin names, filesystem paths, the
// machine hostname, or raw error messages. `checkShareSafe()` enforces the allowlist so a
// future edit that adds a leaky field fails loudly instead of shipping.
//
// The rich, operator-facing log (with hostnames etc.) stays on the Tier-1 pino logger in
// ./logger.ts, which is local to the customer and never shared.

import { randomUUID, randomBytes, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";
import pino from "pino";
import * as grpc from "@grpc/grpc-js";
import type { AppConfig } from "./config";

// Stable, enumerated diagnostic codes. This fixed vocabulary is the only thing a shared
// bundle reveals about *what* went wrong, so a bug is triageable without any payload. Add a
// code here rather than logging an ad-hoc string.
export const DiagCode = {
  Startup: "STARTUP",
  StartupFatal: "STARTUP_FATAL",
  StateFileUnreadable: "STATE_FILE_UNREADABLE",
  PollCycleFailed: "POLL_CYCLE_FAILED",
  ListSandboxesFailed: "LIST_SANDBOXES_FAILED",
  GetDraftPolicyFailed: "GET_DRAFT_POLICY_FAILED",
  PostFailed: "POST_FAILED",
  PostNotInChannel: "POST_NOT_IN_CHANNEL",
  TerminalUpdateFailed: "TERMINAL_UPDATE_FAILED",
  ApproveFailed: "APPROVE_FAILED",
  StaleReviewToken: "STALE_REVIEW_TOKEN",
  RejectFailed: "REJECT_FAILED",
  ReconcileListFailed: "RECONCILE_LIST_FAILED",
  ReconcileGetDraftFailed: "RECONCILE_GET_DRAFT_FAILED",
  AppHomePublishFailed: "APP_HOME_PUBLISH_FAILED",
  BoltUnhandled: "BOLT_UNHANDLED",
} as const;
export type DiagCode = (typeof DiagCode)[keyof typeof DiagCode];

// A random id per process run, so a customer's bundle can be recognized as one session
// without exposing anything about the machine or workspace.
export const sessionId = randomUUID();

// Per-run salt for chunk correlation. Deriving the reference with an HMAC means a customer can
// share "chunkRef ab12cd34 failed 3x" and we can see it is the same chunk across their log
// lines, but we never learn the real OpenShell chunk id. The salt is per-run (not persisted),
// so references are only correlatable within a single session, which is the privacy-preserving
// default and enough for a bug report.
const chunkSalt = randomBytes(16);

export function chunkRef(chunkId: string | undefined): string | undefined {
  if (!chunkId) return undefined;
  return createHmac("sha256", chunkSalt).update(chunkId).digest("hex").slice(0, 8);
}

// A redaction-safe summary of an error. Deliberately excludes `message`, `details`,
// `metadata`, and any axios `config`/`request`/`response` (which carry the bot token in a
// header and can echo request content). Only fixed-vocabulary status identifiers survive.
export interface SafeError {
  name?: string;
  grpcCode?: number; // numeric grpc.status
  grpcStatus?: string; // grpc.status name, e.g. "UNAVAILABLE"
  errorCode?: string; // string codes: Slack "slack_webapi_platform_error", Node "ENOENT", ...
  slackError?: string; // Slack data.error slug, e.g. "not_in_channel" (a fixed vocabulary)
  httpStatus?: number;
  stackTop?: string[]; // our own frames only, absolute paths reduced to src|dist/file:line:col
}

export function safeError(err: unknown): SafeError | undefined {
  if (err == null || typeof err !== "object") return undefined;
  const e = err as Record<string, unknown>;
  const out: SafeError = {};

  if (typeof e.name === "string") out.name = e.name;

  // gRPC ServiceError.code is the numeric status enum; Slack/Node codes are strings.
  if (typeof e.code === "number") {
    out.grpcCode = e.code;
    const nm = (grpc.status as unknown as Record<number, string>)[e.code];
    if (typeof nm === "string") out.grpcStatus = nm;
  } else if (typeof e.code === "string") {
    out.errorCode = e.code;
  }

  const data = e.data as { error?: string } | undefined;
  if (data && typeof data.error === "string") out.slackError = data.error;

  const status = (e.statusCode ?? e.status) as unknown;
  if (typeof status === "number") out.httpStatus = status;

  if (typeof e.stack === "string") {
    const frames = e.stack
      .split("\n")
      .map((l) => l.match(/((?:src|dist)[\\/][^\s):]+:\d+:\d+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .slice(0, 4)
      .map((m) => m[1].replace(/\\/g, "/"));
    if (frames.length) out.stackTop = frames;
  }

  return out;
}

// Non-identifying environment fingerprint: the single most useful thing for triaging a bug,
// with zero PII. Counts and enums only, never names/values, and never os.hostname().
export interface EnvFingerprint {
  appVersion: string;
  nodeVersion: string;
  platform: string;
  arch: string;
  authMode: string;
  useTls: boolean;
  pollIntervalMs: number;
  pollConcurrency: number;
  watchMode: string;
  adminCount: number;
  // Terminal-record retention window in days; omitted entirely when kept forever.
  stateRetentionDays?: number;
  logLevel: string;
}

function readAppVersion(): string {
  const candidates = [
    join(__dirname, "..", "package.json"),
    join(__dirname, "..", "..", "package.json"),
    join(process.cwd(), "package.json"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      }
    } catch {
      // fall through to the next candidate
    }
  }
  return "unknown";
}

export function environmentFingerprint(config: AppConfig): EnvFingerprint {
  return {
    appVersion: readAppVersion(),
    nodeVersion: process.version,
    platform: os.platform(),
    arch: os.arch(),
    authMode: config.openshell.auth.mode,
    useTls: config.openshell.auth.useTls,
    pollIntervalMs: config.pollIntervalMs,
    pollConcurrency: config.pollConcurrency,
    watchMode: config.watchMode,
    adminCount: config.admins.length,
    stateRetentionDays: config.stateRetentionDays,
    logLevel: config.logLevel,
  };
}

// A small, typed context for a diagnostic event. Kept intentionally narrow so call sites
// cannot casually attach a hostname or channel id; anything richer belongs in the Tier-1 log.
export interface DiagContext {
  chunkRef?: string;
  retry?: number;
  count?: number;
  err?: SafeError;
}

// Lazily-built diagnostic sink. Lazy so merely importing this module (e.g. in a unit test)
// does not open/create the diagnostics file. Written synchronously so a fatal-exit event is
// flushed before process.exit().
let cachedLogger: pino.Logger | null = null;
function diagLogger(): pino.Logger {
  if (!cachedLogger) {
    const dest = process.env.DIAGNOSTICS_PATH || "./state/diagnostics.jsonl";
    const stream = pino.destination({ dest, mkdir: true, sync: true });
    // `base` replaces pino's default { pid, hostname } bindings; omitting hostname is
    // deliberate (it is identifying). Level "trace" so every diagnostic is captured
    // regardless of LOG_LEVEL.
    cachedLogger = pino({ level: "trace", base: { sessionId, tier: "diagnostic" } }, stream);
  }
  return cachedLogger;
}

export function diag(code: DiagCode, ctx: DiagContext = {}): void {
  diagLogger().info({ code, ...ctx });
}

export function diagStartup(config: AppConfig): void {
  diagLogger().info({ code: DiagCode.Startup, env: environmentFingerprint(config) });
}

// --- Share-safety enforcement ----------------------------------------------

// The complete set of JSON keys permitted anywhere in a diagnostic line. The bundle export
// refuses to emit if any line carries a key outside this set, so an accidentally-leaky field
// (a hostname, channel id, raw message) fails the check instead of being shared.
export const ALLOWED_DIAG_KEYS: ReadonlySet<string> = new Set([
  // pino envelope
  "level",
  "time",
  "sessionId",
  "tier",
  "msg",
  // event
  "code",
  // context
  "chunkRef",
  "retry",
  "count",
  // SafeError
  "err",
  "name",
  "grpcCode",
  "grpcStatus",
  "errorCode",
  "slackError",
  "httpStatus",
  "stackTop",
  // startup fingerprint
  "env",
  "appVersion",
  "nodeVersion",
  "platform",
  "arch",
  "authMode",
  "useTls",
  "pollIntervalMs",
  "pollConcurrency",
  "watchMode",
  "adminCount",
  "stateRetentionDays",
  "logLevel",
]);

// Patterns that must never appear in a shareable bundle.
const SECRET_PATTERNS: RegExp[] = [
  /xox[bpaso]-[A-Za-z0-9-]{6,}/,
  /xapp-[A-Za-z0-9-]{6,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,
];

export interface ShareSafetyResult {
  ok: boolean;
  violations: string[];
}

function collectKeys(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, acc);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
}

// Validate a set of diagnostic JSONL lines is safe to share: every key is on the allowlist and
// no line matches a secret pattern. Allowlist (not blocklist) is the contract, so unknown
// fields are violations by default.
export function checkShareSafe(lines: string[]): ShareSafetyResult {
  const violations: string[] = [];
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const n = i + 1;
    for (const re of SECRET_PATTERNS) {
      if (re.test(trimmed)) violations.push(`line ${n}: matches secret pattern ${re}`);
    }
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      violations.push(`line ${n}: not valid JSON`);
      return;
    }
    const keys = new Set<string>();
    collectKeys(obj, keys);
    for (const k of keys) {
      if (!ALLOWED_DIAG_KEYS.has(k)) violations.push(`line ${n}: disallowed key "${k}"`);
    }
  });
  return { ok: violations.length === 0, violations };
}
