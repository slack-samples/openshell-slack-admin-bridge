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
  dataschema: string | null;
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

function asEpochMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function severityFromLogLevel(v: unknown): { severity: string; severity_id: number } | null {
  if (typeof v !== "string") return null;
  switch (v.trim().toUpperCase()) {
    case "TRACE":
    case "DEBUG":
    case "INFO":
      return { severity: "Informational", severity_id: 1 };
    case "WARN":
    case "WARNING":
      return { severity: "Medium", severity_id: 3 };
    case "ERROR":
      return { severity: "High", severity_id: 4 };
    case "CRITICAL":
      return { severity: "Critical", severity_id: 5 };
    case "FATAL":
      return { severity: "Fatal", severity_id: 6 };
    default:
      return null;
  }
}

// The OpenShell Event Exporter sends envelope-v1 rather than a bare OCSF object.
// Preserve the original event for Slack's OCSF renderer, while filling only
// missing display/summary fields from the exporter's canonical context. This is
// especially important for WatchSandbox operational log records, whose native
// names are sandbox_id/timestamp_ms/level rather than OCSF metadata.uid/time/
// severity. Existing OCSF values always win.
function unwrapOpenShellEnvelope(data: Record<string, unknown>, cloudEventTime: string | null): unknown {
  if (!("original" in data)) return null;
  if (!isObject(data.original)) return data.original;

  const original = data.original;
  const adapted: Record<string, unknown> = { ...original };
  const openshell = isObject(data.openshell) ? data.openshell : {};

  const existingMetadata = isObject(original.metadata) ? original.metadata : {};
  if (asStringAttr(existingMetadata.uid) === null) {
    const sandboxId = asStringAttr(openshell.sandbox_id) ?? asStringAttr(original.sandbox_id);
    if (sandboxId) adapted.metadata = { ...existingMetadata, uid: sandboxId };
  }

  if (asEpochMs(original.time) === null) {
    const sourceTime = asEpochMs(original.timestamp_ms);
    const envelopeTime = cloudEventTime ? Date.parse(cloudEventTime) : Number.NaN;
    if (sourceTime !== null) adapted.time = sourceTime;
    else if (Number.isFinite(envelopeTime)) adapted.time = envelopeTime;
  }

  if (asStringAttr(original.severity) === null) {
    const mapped = severityFromLogLevel(original.level);
    if (mapped) Object.assign(adapted, mapped);
  }

  return adapted;
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

  const time = asStringAttr(value.time);
  const dataschema = asStringAttr(value.dataschema);
  if (dataschema === "urn:openshell:event-envelope:1") {
    if (!isObject(data) || !("original" in data)) {
      return {
        ok: false,
        error: "OpenShell event envelope is missing data.original",
        raw: value,
      };
    }
    data = unwrapOpenShellEnvelope(data, time);
  }

  return {
    ok: true,
    type,
    id: asStringAttr(value.id),
    source: asStringAttr(value.source),
    subject: asStringAttr(value.subject),
    time,
    dataschema,
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
