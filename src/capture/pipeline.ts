// The source-agnostic middle of the audit sink. Both ingestion sources (the
// JSONL file tailer and the HTTP receiver) produce bare OCSF objects and hand
// them here; everything downstream — normalize, filter, render — is shared and
// already unit-tested in isolation. Sources stay ignorant of Slack, and the
// send path stays ignorant of where events came from.

import { normalizeOcsf, type NormalizedAuditEvent } from "./normalize";
import { shouldCapture } from "./filter";
import { renderAudit, type RenderedAudit } from "./blocks";
import { childLogger } from "../logger";

const log = childLogger("capture-pipeline");

// Normalize one parsed OCSF object and apply the noise filter, returning the
// normalized event when it should be captured or null when the filter drops it.
// Shared by the renderer and the ingestor so an object is normalized exactly once
// on the hot path. `cloudEventType` is the CloudEvents `type` when the object
// arrived wrapped in an envelope (the file source has none); it lets the filter
// match on the wire type in addition to the OCSF class/type names.
export function normalizeAndFilter(
  obj: unknown,
  excludeEventTypes: string[],
  cloudEventType?: string,
): NormalizedAuditEvent | null {
  const ev = normalizeOcsf(obj);
  return shouldCapture(ev, excludeEventTypes, cloudEventType) ? ev : null;
}

// Turn one parsed OCSF object into a ready-to-post Slack message, or null when
// the noise filter drops it.
export function renderOcsfObject(
  obj: unknown,
  excludeEventTypes: string[],
  cloudEventType?: string,
): RenderedAudit | null {
  const ev = normalizeAndFilter(obj, excludeEventTypes, cloudEventType);
  return ev ? renderAudit(ev) : null;
}

// A sink accepts rendered messages and returns false when it could not accept
// one (e.g. its bounded queue is full), so callers can count the drop.
export type AuditSink = (post: RenderedAudit) => boolean;

// An ingestor is what sources call: hand it a parsed OCSF object and it filters,
// renders, and forwards to the sink. Returns the disposition so a source can log
// per-event outcomes without knowing anything about rendering or Slack.
export type IngestOutcome = "posted" | "filtered" | "dropped";

// `onCaptured` (optional) is invoked with every event that passes the noise
// filter, BEFORE rendering/posting, so the caller can aggregate activity counts
// (the App Home summary) independently of whether the event is also forwarded to
// Slack. It is wrapped in try/catch here: a summary failure must never break the
// audit feed.
export function createIngestor(
  excludeEventTypes: string[],
  sink: AuditSink,
  onCaptured?: (ev: NormalizedAuditEvent) => void,
) {
  return function ingestObject(obj: unknown, cloudEventType?: string): IngestOutcome {
    const ev = normalizeAndFilter(obj, excludeEventTypes, cloudEventType);
    if (!ev) return "filtered";
    if (onCaptured) {
      try {
        onCaptured(ev);
      } catch (err) {
        log.warn({ err }, "Audit summary update failed; continuing to post.");
      }
    }
    return sink(renderAudit(ev)) ? "posted" : "dropped";
  };
}

export type Ingestor = ReturnType<typeof createIngestor>;
