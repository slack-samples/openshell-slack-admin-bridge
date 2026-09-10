// Normalize a flat OCSF event object (the `data` payload of a CloudEvent) into a
// display-ready shape. This is deliberately tolerant: the audit feed captures
// every class, including ones this bridge has never seen, so nothing here may
// throw on a missing or oddly-typed field. Whatever we cannot map cleanly is
// preserved verbatim in `extra` and shown as a raw detail block downstream.
//
// Grounded in openshell-ocsf (crates/openshell-ocsf): every event flattens
// BaseEventData, whose custom Serialize always emits class_uid/class_name,
// category_uid/category_name, activity_id/activity_name, type_uid/type_name,
// time (epoch ms), the severity_id+severity pair, metadata, and — when present
// — the status_id+status pair, message, status_detail, device, container,
// ai_model and unmapped. Per-class fields (endpoints, process, http, ...) are
// flattened alongside and land in `extra`.

// Base keys owned by BaseEventData. Everything else in the object is
// class-specific and surfaced through `extra`.
export const OCSF_BASE_KEYS: ReadonlySet<string> = new Set([
  "class_uid",
  "class_name",
  "category_uid",
  "category_name",
  "activity_id",
  "activity_name",
  "type_uid",
  "type_name",
  "time",
  "severity_id",
  "severity",
  "status_id",
  "status",
  "message",
  "status_detail",
  "metadata",
  "device",
  "container",
  "ai_model",
  "unmapped",
]);

export interface NormalizedAuditEvent {
  classUid: number | null;
  className: string;
  activityName: string;
  typeName: string;
  typeUid: number | null;
  timeMs: number | null;
  severityId: number | null;
  severity: string;
  statusId: number | null;
  status: string | null;
  message: string | null;
  statusDetail: string | null;
  // metadata.uid is the sandbox id (reused across a sandbox's events, not
  // event-unique). metadata.product.name identifies the emitter.
  sandboxUid: string | null;
  productName: string | null;
  container: { name: string | null; uid: string | null; image: string | null } | null;
  deviceHostname: string | null;
  // Class-specific fields (everything not in OCSF_BASE_KEYS) plus the OCSF
  // `unmapped` bag, shown as a raw detail block. Attacker-influenceable.
  extra: Record<string, unknown>;
}

function asString(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function normalizeContainer(v: unknown): NormalizedAuditEvent["container"] {
  if (!isObject(v)) return null;
  const image = isObject(v.image) ? asString(v.image.name) : asString(v.image);
  return { name: asString(v.name), uid: asString(v.uid), image };
}

export function normalizeOcsf(input: unknown): NormalizedAuditEvent {
  const o: Record<string, unknown> = isObject(input) ? input : {};

  const className = asString(o.class_name) ?? "Unknown";
  const activityName = asString(o.activity_name) ?? "";
  // Prefer the emitted type_name; fall back to the OCSF convention
  // "{class_name}: {activity_name}" when it is absent.
  const typeName =
    asString(o.type_name) ?? (activityName ? `${className}: ${activityName}` : className);

  const metadata = isObject(o.metadata) ? o.metadata : {};
  const product = isObject(metadata.product) ? metadata.product : {};
  const device = isObject(o.device) ? o.device : null;

  // A null-prototype bag: a class-specific or unmapped field literally named
  // "__proto__" is then stored as a real key (no inherited setter to hit) and no
  // Object.prototype member name (toString, valueOf, ...) is spuriously seen as
  // already-present. The audit sink must lose nothing.
  const extra: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(o)) {
    if (!OCSF_BASE_KEYS.has(k)) extra[k] = v;
  }
  // Fold the OCSF `unmapped` bag (e.g. policy_version/policy_hash/auto markers on
  // config-state-change events) into the detail view rather than dropping it.
  if (isObject(o.unmapped)) {
    for (const [k, v] of Object.entries(o.unmapped)) {
      if (!Object.prototype.hasOwnProperty.call(extra, k)) extra[k] = v;
    }
  }

  return {
    classUid: asNumber(o.class_uid),
    className,
    activityName,
    typeName,
    typeUid: asNumber(o.type_uid),
    timeMs: asNumber(o.time),
    severityId: asNumber(o.severity_id),
    severity: asString(o.severity) ?? "Unknown",
    statusId: asNumber(o.status_id),
    status: asString(o.status),
    message: asString(o.message),
    statusDetail: asString(o.status_detail),
    sandboxUid: asString(metadata.uid),
    productName: asString(product.name),
    container: normalizeContainer(o.container),
    deviceHostname: device ? asString(device.hostname) : null,
    extra,
  };
}
