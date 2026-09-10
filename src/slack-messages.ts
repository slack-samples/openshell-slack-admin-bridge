import type { KnownBlock, Button, View } from "@slack/types";
import type { ActionRequest } from "./action-request";
import { truncate } from "./slack-text";

// Shared interaction action ids. The approval/terminal message builders below stay on GA
// blocks (channel messages), while the App Home reuses ACTION_APPROVE / ACTION_REJECT on its
// carousel-card buttons (same handlers, keyed by button `value`). ACTION_OPEN_REQUEST is the
// App Home "open request" deep-link button; it carries a `url`, so its handler only needs to
// ack the interaction.
export const ACTION_APPROVE = "approve_chunk";
export const ACTION_REJECT = "reject_chunk";
export const ACTION_OPEN_REQUEST = "open_request";
// App Home Analytics button: opens the approvals-vs-rejections modal. The decisions line chart
// lives there (not inline) because a Home view is capped at 2 data_visualization blocks, which the
// two audit charts already claim; the modal is a separate view with its own chart budget.
export const ACTION_VIEW_DECISIONS = "view_decisions";
export const DECISIONS_MODAL_CALLBACK = "decisions_modal";
export const REJECT_MODAL_CALLBACK = "reject_modal";
export const REJECT_REASON_BLOCK = "reason_block";
export const REJECT_REASON_INPUT = "reason_input";

function confidenceLabel(req: ActionRequest): string {
  if (req.proposerType === "mechanistic") return "mechanistic (deterministic)";
  return `agent-authored (${Math.round(req.confidence * 100)}% confidence)`;
}

function endpointLines(req: ActionRequest): string {
  if (!req.endpoints.length) return "_no endpoints on proposed rule_";
  return req.endpoints
    .map((e) => {
      const l7 = e.l7 ? ` · L7: ${e.l7}` : "";
      return `\`${e.host}\` port ${e.ports} (${e.protocol})${l7}`;
    })
    .join("\n");
}

// Identifiers only travel in button values / modal metadata. The review_token and
// sandbox routing are re-read from the durable store at action time.
export function approveValue(req: ActionRequest): string {
  return req.chunkId;
}

export function buildApprovalText(req: ActionRequest): string {
  return `Egress approval needed: ${req.ruleName} for sandbox ${req.sandboxName} (workspace ${req.workspace})`;
}

export function buildApprovalBlocks(req: ActionRequest): KnownBlock[] {
  const blocks: KnownBlock[] = [];

  blocks.push({
    type: "header",
    text: { type: "plain_text", text: truncate(`Egress approval: ${req.ruleName}`, 150), emoji: true },
  });

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Sandbox*\n${req.sandboxName}` },
      { type: "mrkdwn", text: `*Workspace*\n${req.workspace}` },
      { type: "mrkdwn", text: `*Proposer*\n${confidenceLabel(req)}` },
      { type: "mrkdwn", text: `*Denials seen*\n${req.hitCount} hit(s), ${req.denialCount} summary(ies)` },
    ],
  });

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: truncate(`*Requested egress*\n${endpointLines(req)}`, 3000) },
  });

  if (req.binaries.length) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Binaries: ${req.binaries.map((b) => `\`${b}\``).join(", ")}` }],
    });
  }

  if (req.rationale) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Rationale*\n${req.rationale}`, 3000) },
    });
  }

  if (req.securityNotes) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`:warning: *Security notes*\n${req.securityNotes}`, 3000) },
    });
  }

  if (req.validationResult) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Validation: ${truncate(req.validationResult, 500)}` }],
    });
  }

  const approveBtn: Button = {
    type: "button",
    text: { type: "plain_text", text: "Approve", emoji: true },
    style: "primary",
    action_id: ACTION_APPROVE,
    value: approveValue(req),
    confirm: {
      title: { type: "plain_text", text: "Approve egress?" },
      text: {
        type: "mrkdwn",
        // Slack caps confirm-dialog text at 300 chars; sandbox names can be long.
        text: truncate(
          `This will merge the rule into the *${req.workspace}* policy for sandbox *${req.sandboxName}* and hot-reload it.`,
          300,
        ),
      },
      confirm: { type: "plain_text", text: "Approve" },
      deny: { type: "plain_text", text: "Cancel" },
    },
  };

  const rejectBtn: Button = {
    type: "button",
    text: { type: "plain_text", text: "Reject", emoji: true },
    style: "danger",
    action_id: ACTION_REJECT,
    value: req.chunkId,
  };

  blocks.push({ type: "actions", block_id: `decide_${req.chunkId}`, elements: [approveBtn, rejectBtn] });

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `chunk \`${req.chunkId}\`${req.supersedesChunkId ? ` (supersedes \`${req.supersedesChunkId}\`)` : ""}` }],
  });

  return blocks;
}

export interface TerminalOutcome {
  status: "approved" | "rejected" | "closed";
  byUserId?: string;
  byName?: string;
  reason?: string;
  policyVersion?: number;
  whenIso?: string;
}

export function buildTerminalBlocks(req: ActionRequest, outcome: TerminalOutcome): KnownBlock[] {
  const icon = outcome.status === "approved" ? ":white_check_mark:" : outcome.status === "rejected" ? ":x:" : ":information_source:";
  const verb = outcome.status === "approved" ? "Approved" : outcome.status === "rejected" ? "Rejected" : "Closed";

  const who = outcome.byUserId ? `by <@${outcome.byUserId}>` : outcome.byName ? `by ${outcome.byName}` : "";
  const when = outcome.whenIso ? ` at ${outcome.whenIso}` : "";
  const ver = outcome.status === "approved" && outcome.policyVersion ? ` · policy v${outcome.policyVersion}` : "";

  const blocks: KnownBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: truncate(`${verb}: ${req.ruleName}`, 150), emoji: true },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Sandbox*\n${req.sandboxName}` },
        { type: "mrkdwn", text: `*Workspace*\n${req.workspace}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Requested egress*\n${endpointLines(req)}`, 3000) },
    },
  ];

  if (outcome.status === "rejected" && outcome.reason) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncate(`*Reason*\n${outcome.reason}`, 3000) },
    });
  }

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${icon} ${verb} ${who}${when}${ver} · chunk \`${req.chunkId}\`` }],
  });

  return blocks;
}

export function buildTerminalText(req: ActionRequest, outcome: TerminalOutcome): string {
  const verb = outcome.status === "approved" ? "Approved" : outcome.status === "rejected" ? "Rejected" : "Closed";
  return `${verb}: ${req.ruleName} for ${req.sandboxName}`;
}

// Reject modal. private_metadata carries identifiers only.
export interface RejectModalMeta {
  chunkId: string;
  channelId: string;
  messageTs: string;
}

export function buildRejectModal(meta: RejectModalMeta, ruleName: string, reasonRequired: boolean): View {
  return {
    type: "modal",
    callback_id: REJECT_MODAL_CALLBACK,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Reject egress" },
    submit: { type: "plain_text", text: "Reject" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: truncate(`Rejecting *${ruleName}*. The sandbox stays denied and retries later.`, 3000) },
      },
      {
        type: "input",
        block_id: REJECT_REASON_BLOCK,
        optional: !reasonRequired,
        label: { type: "plain_text", text: "Reason" },
        element: {
          type: "plain_text_input",
          action_id: REJECT_REASON_INPUT,
          multiline: true,
          max_length: 500,
          placeholder: { type: "plain_text", text: "Why is this egress denied? (shown in audit history)" },
        },
      },
    ],
  };
}

export function parseRejectMetadata(privateMetadata: string): RejectModalMeta {
  return JSON.parse(privateMetadata) as RejectModalMeta;
}
