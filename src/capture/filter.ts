import type { NormalizedAuditEvent } from "./normalize";

// Optional noise filter for the audit feed. The default (an empty exclude list)
// captures everything, which is the goal; this only lets an operator silence
// specific classes they find noisy. There is deliberately NO dedup against the
// approve/reject side — the audit feed is an independent firehose, and an
// approval-outcome event appearing in both places is acceptable.
//
// Matching is case-insensitive and exact against the event's CloudEvents `type`,
// its OCSF `class_name`, and its OCSF `type_name` ("{class_name}: {activity_name}").
// Exact (not substring) matching avoids an entry like "HTTP" silently dropping
// unrelated classes.

export function shouldCapture(
  ev: NormalizedAuditEvent,
  excludeEventTypes: readonly string[],
  cloudEventType?: string | null,
): boolean {
  if (!excludeEventTypes.length) return true;

  const excluded = new Set(excludeEventTypes.map((s) => s.trim().toLowerCase()).filter(Boolean));
  if (!excluded.size) return true;

  const candidates = [cloudEventType, ev.className, ev.typeName]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => s.toLowerCase());

  return !candidates.some((c) => excluded.has(c));
}
