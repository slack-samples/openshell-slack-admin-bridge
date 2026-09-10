import pino from "pino";

const level = process.env.LOG_LEVEL || "info";

// Tier-1 (operator-facing, local) error serializer. Keeps what a human debugging on the
// customer's own host needs (message + stack + status), but explicitly DROPS the axios-shaped
// `config` / `request` / `response` and `metadata`, which would otherwise carry the Slack bot
// token in an Authorization header and can echo request content. The share-safe Tier-2 log
// (src/diagnostics.ts) is even stricter and drops the message too.
function serializeErr(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & Record<string, unknown>;
  const out: Record<string, unknown> = {
    type: e.name,
    message: e.message,
    stack: e.stack,
  };
  if (typeof e.code !== "undefined") out.code = e.code;
  const data = e.data as { error?: string } | undefined;
  if (data && typeof data.error === "string") out.slackError = data.error;
  const status = (e.statusCode ?? e.status) as unknown;
  if (typeof status === "number") out.statusCode = status;
  return out;
}

// Redact anything that could carry a secret if it ever ends up on a log line. Belt-and-
// suspenders alongside serializeErr: catches token-named fields on directly-logged objects.
export const logger = pino({
  level,
  serializers: { err: serializeErr },
  redact: {
    paths: [
      "token",
      "*.token",
      "botToken",
      "*.botToken",
      "appToken",
      "*.appToken",
      "bearerToken",
      "*.bearerToken",
      "authorization",
      "*.authorization",
      "*.headers.authorization",
      "*.headers.Authorization",
      "review_token",
      "*.review_token",
      "reviewToken",
      "*.reviewToken",
    ],
    censor: "[redacted]",
  },
});

export function childLogger(name: string) {
  return logger.child({ module: name });
}
