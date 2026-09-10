import type { KnownBlock } from "@slack/types";
import { truncate, escapeMrkdwn } from "../slack-text";
import type { NormalizedAuditEvent } from "./normalize";

// Render a normalized OCSF event as a non-interactive Slack message for the
// audit feed. There are no buttons or actions here: the audit channel is a
// read-only firehose, structurally separate from the approve/reject surface.
//
// Every freeform, attacker-influenceable value (message, status detail, and the
// raw detail bag) is escaped so a sandboxed agent cannot inject a link, a
// <@mention>, or a <!channel> broadcast into the feed.

const SECTION_LIMIT = 3000;
const HEADER_LIMIT = 150;

function severityEmoji(id: number | null): string {
  switch (id) {
    case 6:
      return ":skull:"; // Fatal
    case 5:
      return ":rotating_light:"; // Critical
    case 4:
      return ":red_circle:"; // High
    case 3:
      return ":large_orange_circle:"; // Medium
    case 2:
      return ":large_yellow_circle:"; // Low
    case 1:
      return ":large_blue_circle:"; // Informational
    default:
      return ":white_circle:"; // Unknown (0), Other (99), or unrecognized
  }
}

function isoTime(ms: number | null): string {
  if (ms === null) return "unknown time";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "unknown time";
  }
}

// Fence untrusted multi-line content as a code block. Backticks in the content
// are neutralized (U+02BC) so a value cannot break out of the fence, and the
// three Slack-special characters are escaped defensively.
function codeBlock(content: string, limit: number): string {
  const safe = escapeMrkdwn(content).replace(/`/g, "ʼ");
  return "```\n" + truncate(safe, limit) + "\n```";
}

// Fence an untrusted value as an inline code span. Backticks are neutralized
// (U+02BC) so the value cannot break out of the span, then the three
// Slack-special characters are escaped. Mirrors codeBlock for single-line use.
function inlineCode(s: string): string {
  return "`" + escapeMrkdwn(s).replace(/`/g, "ʼ") + "`";
}

// A section `fields` entry. The values here are OpenShell-set enums and bounded
// ids, but truncate defensively so a single oversized value can never breach
// Slack's 2000-char per-field ceiling and reject the whole message.
function labeled(label: string, value: string | null): string {
  return `*${label}*\n${value && value.length ? truncate(escapeMrkdwn(value), 1900) : "_none_"}`;
}

export interface RenderedAudit {
  text: string;
  blocks: KnownBlock[];
}

export function buildAuditText(ev: NormalizedAuditEvent): string {
  // The top-level `text` is rendered as mrkdwn (notification + fallback), so
  // escape the attacker-influenceable typeName/message here too.
  const base = `${escapeMrkdwn(ev.severity)} · ${escapeMrkdwn(ev.typeName)}`;
  const tail = ev.message ? `: ${escapeMrkdwn(ev.message)}` : "";
  return truncate(`${base}${tail}`, 300);
}

export function buildAuditBlocks(ev: NormalizedAuditEvent): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: "header",
    text: {
      type: "plain_text",
      text: truncate(`${severityEmoji(ev.severityId)} ${ev.typeName}`, HEADER_LIMIT),
      emoji: true,
    },
  });

  const classField = ev.classUid !== null ? `${ev.className} (${ev.classUid})` : ev.className;
  const sevField = ev.severityId !== null ? `${ev.severity} (${ev.severityId})` : ev.severity;
  const fields = [
    labeled("Class", classField),
    labeled("Activity", ev.activityName),
    labeled("Severity", sevField),
    labeled("Status", ev.status),
    labeled("Sandbox", ev.sandboxUid),
    labeled("Time", isoTime(ev.timeMs)),
  ];
  blocks.push({ type: "section", fields: fields.map((text) => ({ type: "mrkdwn", text })) });

  if (ev.container) {
    const parts = [
      ev.container.name ? `name ${inlineCode(ev.container.name)}` : null,
      ev.container.image ? `image ${inlineCode(ev.container.image)}` : null,
      ev.container.uid ? `uid ${inlineCode(ev.container.uid)}` : null,
    ].filter(Boolean);
    if (parts.length) {
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: truncate(`Container: ${parts.join(" · ")}`, SECTION_LIMIT) }],
      });
    }
  }

  if (ev.message) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Message*\n${escapeMrkdwn(ev.message)}`, SECTION_LIMIT) },
    });
  }

  if (ev.statusDetail) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Detail*\n${escapeMrkdwn(ev.statusDetail)}`, SECTION_LIMIT) },
    });
  }

  const extraKeys = Object.keys(ev.extra);
  if (extraKeys.length) {
    let json: string;
    try {
      json = JSON.stringify(ev.extra, null, 2);
    } catch {
      json = String(ev.extra);
    }
    // Reserve room for the fence, escaping, and the "*Fields*" label.
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Fields*\n${codeBlock(json, SECTION_LIMIT - 200)}` },
    });
  }

  const footer = [
    ev.productName ? escapeMrkdwn(ev.productName) : null,
    ev.deviceHostname ? `host ${escapeMrkdwn(ev.deviceHostname)}` : null,
    ev.typeUid !== null ? `type_uid ${ev.typeUid}` : null,
  ].filter(Boolean);
  if (footer.length) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(footer.join(" · "), SECTION_LIMIT) }] });
  }

  return blocks;
}

export function renderAudit(ev: NormalizedAuditEvent): RenderedAudit {
  return { text: buildAuditText(ev), blocks: buildAuditBlocks(ev) };
}
