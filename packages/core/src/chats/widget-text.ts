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

/** The lines `preview` says. An app's preview and a stored card are not
 *  checked, so a field of the wrong shape reads as nothing. */
function previewLines(preview: PreviewPayload): unknown[] {
  if (preview.kind === "sensitive_message") {
    return [
      preview.text,
      ...(typeof preview.reason === "string" ? [`Why: ${preview.reason}`] : []),
    ];
  }
  const fields: unknown[] = Array.isArray(preview.fields) ? preview.fields : [];
  return [
    preview.summary,
    ...fields.flatMap((field) => {
      const { label, value } = (field ?? {}) as { label?: unknown; value?: unknown };
      return typeof label === "string" && typeof value === "string" ? [`${label}: ${value}`] : [];
    }),
  ];
}

/** The plain-text version of an approval card: what its preview says the
 *  agent wants to do, and, while it waits, where the guardian answers it. */
export function approvalCardText(card: ApprovalCard): string {
  const title =
    card.preview.kind === "generic"
      ? typeof card.preview.title === "string"
        ? card.preview.title
        : card.actionName
      : "send this message";
  const lines = [`${APPROVAL_HEADING[card.status] ?? APPROVAL_HEADING.pending}: ${title}`];
  lines.push(
    ...previewLines(card.preview).filter(
      (line): line is string => typeof line === "string" && line.trim() !== "",
    ),
  );
  if (card.status === "pending")
    lines.push("The guardian approves or denies it on Rome's dashboard.");
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
  if (part.type === "approval_card" && typeof part.preview === "object" && part.preview) {
    return approvalCardText(part);
  }
  return undefined;
}
