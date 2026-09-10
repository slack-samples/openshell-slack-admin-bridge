// Parse the CloudEvents 1.0 envelope the OpenShell OCSF exporter POSTs, in
// STRUCTURED mode: the HTTP body is JSON that carries both the CloudEvents
// context attributes and the event `data`. A single event uses content-type
// `application/cloudevents+json`; a batch uses `application/cloudevents-batch+json`
// and is a JSON array of envelopes.
//
// This is grounded in the public CloudEvents 1.0 spec, not in a vendored
// exporter: `specversion`, `id`, `source`, `type` are context attributes, and
// the payload travels in `data` (a JSON value) or `data_base64` (base64 of the
// bytes). The exporter's exact `type` namespace is not needed here — the audit
// feed captures every type — and BINARY mode (attributes in HTTP headers, body
// = data) is the receiver's concern: it can build an envelope value and call
// parseEnvelope() directly.
//
// Failure is per-item and fail-closed: a malformed envelope is quarantined
// (`ok: false`) with the raw value preserved, never silently dropped, so one bad
// event cannot poison a batch and nothing disappears without a trace.

export interface ParsedEnvelopeOk {
  ok: true;
  // CloudEvents context attributes (id/source/subject/time optional per spec).
  type: string;
  id: string | null;
  source: string | null;
  subject: string | null;
  time: string | null;
  // The decoded event payload — expected to be a flat OCSF object.
  data: unknown;
}

export interface ParsedEnvelopeErr {
  ok: false;
  error: string;
  raw: unknown;
}

export type ParsedEnvelope = ParsedEnvelopeOk | ParsedEnvelopeErr;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringAttr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

// Parse one already-JSON-decoded CloudEvents envelope value. Reusable for binary
// mode, where the receiver assembles the envelope from headers + body.
export function parseEnvelope(value: unknown): ParsedEnvelope {
  if (!isObject(value)) {
    return { ok: false, error: "envelope is not a JSON object", raw: value };
  }

  const type = asStringAttr(value.type);
  if (!type) {
    return { ok: false, error: "missing required CloudEvents attribute: type", raw: value };
  }

  // Resolve the payload: prefer `data`; fall back to base64. A `data` string may
  // itself be a JSON document (some producers stringify it) — try to parse, but
  // keep the string if it is just text.
  let data: unknown;
  if ("data_base64" in value && typeof value.data_base64 === "string") {
    try {
      const decoded = Buffer.from(value.data_base64, "base64").toString("utf8");
      data = JSON.parse(decoded);
    } catch {
      return { ok: false, error: "data_base64 is not base64-encoded JSON", raw: value };
    }
  } else if (typeof value.data === "string") {
    try {
      data = JSON.parse(value.data);
    } catch {
      data = value.data;
    }
  } else {
    data = value.data ?? null;
  }

  return {
    ok: true,
    type,
    id: asStringAttr(value.id),
    source: asStringAttr(value.source),
    subject: asStringAttr(value.subject),
    time: asStringAttr(value.time),
    data,
  };
}

function isBatch(parsed: unknown, contentType: string | undefined): boolean {
  if (Array.isArray(parsed)) return true;
  return !!contentType && contentType.toLowerCase().includes("cloudevents-batch");
}

// Parse a raw HTTP body (structured single or batch) into envelopes. A body that
// is not valid JSON yields a single quarantined item rather than throwing, so
// the receiver can log/surface it and keep serving.
export function parseCloudEventsBody(body: string, contentType?: string): ParsedEnvelope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    return [{ ok: false, error: `body is not valid JSON: ${(err as Error).message}`, raw: body }];
  }

  if (isBatch(parsed, contentType)) {
    if (!Array.isArray(parsed)) {
      return [{ ok: false, error: "batch content-type but body is not a JSON array", raw: parsed }];
    }
    return parsed.map(parseEnvelope);
  }

  return [parseEnvelope(parsed)];
}
