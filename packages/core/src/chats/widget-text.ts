// How a widget reads as plain text, for a platform that cannot draw it.
// Vocabulary: docs/domains/chats.md#widget.

import type { ApprovalCardStatus, MessagePart, PreviewPayload } from "@rome-os/app-runtime";

type ApprovalCard = Extract<MessagePart, { type: "approval_card" }>;

/** What an approval request's plain-text line opens with, by its state. */
const APPROVAL_HEADING: Record<ApprovalCardStatus, string> = {
  pending: "Approval needed",
  approved: "Approved",
  rejected: "Denied",
  executing: "Approved, running",
  executed: "Approved and done",
  failed: "Approved, but it failed",
};

function previewLines(preview: PreviewPayload): string[] {
  if (preview.kind === "sensitive_message") {
    return [preview.text, ...(preview.reason ? [`Why: ${preview.reason}`] : [])];
  }
  return [
    preview.summary,
    ...(preview.fields ?? []).map((field) => `${field.label}: ${field.value}`),
  ];
}

/** The plain-text version of an approval card: what the agent wants to do,
 *  and, while it waits, where the guardian answers it. */
export function approvalCardText(card: ApprovalCard): string {
  const title = card.preview.kind === "generic" ? card.preview.title : "send this message";
  const lines = [`${APPROVAL_HEADING[card.status] ?? APPROVAL_HEADING.pending}: ${title}`];
  lines.push(...previewLines(card.preview).filter((line) => line.trim()));
  if (card.status === "pending") lines.push("Approve or deny it on Rome's dashboard.");
  return lines.join("\n");
}

/**
 * The plain-text line of `part` when it is a widget whose kind defines one,
 * else undefined. Text is not a widget. A part with no line of its own, such
 * as a turn recap or a routine draft, answers undefined too, and a platform
 * that cannot draw it refuses it.
 */
export function widgetText(part: MessagePart): string | undefined {
  // A card that arrived without its preview has nothing to say, so it is
  // refused like any part with no line.
  if (part.type === "approval_card" && part.preview) return approvalCardText(part);
  return undefined;
}
