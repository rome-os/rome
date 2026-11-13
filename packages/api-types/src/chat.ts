// WebChat transcript part wire types: the parts core stores as a message's
// content, re-exported so web reads the same union core writes.

import type { MessagePart } from "@rome-os/app-runtime";
import type { ConciergeConnectEntry } from "./concierge.js";
import type { TraceErrorEvent } from "./trace-segments.js";

export type {
  ApprovalCardStatus,
  MessagePart,
  PreviewPayload,
  RoutineDraftSpec,
} from "@rome-os/app-runtime";

// The check core runs before it stores a described card, so a reader can run
// it again on the stored part before drawing it or calling the app.
export { checkWidgetUi, isWidgetAppPath } from "@rome-os/app-runtime";

/** Error core stores as a turn's assistant content when model resolution fails
 * before the turn runs. It carries the trace error event's fields. */
export type StoredErrorPart = Pick<
  TraceErrorEvent,
  "type" | "error" | "code" | "provider" | "reason"
>;

/** The task chat a forwarded message came from. `title` is the chat's name
 * when it was forwarded. */
export interface ForwardedFrom {
  chatId: string;
  title: string;
}

/** A text part as WebChat stores it. `format` is a display hint only the
 * `say` tool sets: `long` shows the text as one long message, `bubble` or
 * absent as a chat bubble where the chat shows bubbles. `forwardedFrom` is set
 * only on text forwarded word for word from a task chat. */
export type WebchatTextPart = Extract<MessagePart, { type: "text" }> & {
  format?: "bubble" | "long";
  forwardedFrom?: ForwardedFrom;
};

/** A card for a chat that another agent's tool started on the guardian's
 * behalf. The chat's live status is read from the chat itself. */
export interface TaskChatPart {
  type: "task_chat";
  chatId: string;
  title: string;
  /**
   * What the card shows: `task`, the task card (its title, status, Stop and
   * Open), or `ask`, the task's question or approval alone. A card from
   * before has none, and shows the task card with its waiting question or
   * approval inside.
   */
  show?: "task" | "ask";
}

/** A card that connects a service for the guardian. `connect` is the service's
 * entry from the Concierge's connector list, which says how the client starts
 * connecting it. Only the host writes one: the client acts on its `connect`. */
export interface ConnectCardPart {
  type: "connect_card";
  service: string;
  label: string;
  /** The id of the service's mark, as the connector list gave it. A card
   * written before it existed has none. */
  icon?: string | null;
  connect: ConciergeConnectEntry;
}

/** Longest `text` a {@link ReplyToPart} keeps; core truncates longer snapshots with an ellipsis. */
export const REPLY_TO_TEXT_MAX_LENGTH = 1000;

/** The message a user message replies to, snapshotted when it was sent. It is
 * the first part of the reply, so the quote stays whole after the original
 * leaves the transcript. `text` is the quoted selection or the whole message. */
export interface ReplyToPart {
  type: "reply_to";
  messageId: string;
  author: "guardian" | "agent" | "automated";
  name?: string;
  text: string;
}

/** Host-written notice of the Concierge chat's subscription quota failover. */
export interface QuotaSwitchPart {
  type: "quota_switch";
  reason?: "quota" | "login" | "temporary" | "model_limit";
  fromModel?: string;
  from: "openai" | "anthropic";
  to: "openai" | "anthropic";
  model: string;
}

/** One part of a stored WebChat message's content. */
export type TranscriptPart =
  | Exclude<MessagePart, { type: "text" }>
  | WebchatTextPart
  | StoredErrorPart
  | TaskChatPart
  | ConnectCardPart
  | ReplyToPart
  | QuotaSwitchPart;

/** The person or automation that sent a WebChat user message, resolved at load
 * time. Absent when no sender was recorded. Automation names the actual source;
 * onBehalfOf supplies the person whose avatar and viewer-relative side it uses.
 * A null source type and name mark an unknown automation. */
export type ChatMessageSender =
  | {
      kind: "automated";
      sourceType: "agent" | "app" | "routine" | null;
      name: string | null;
      iconUrl: string | null;
      onBehalfOf?: { kind: "guardian"; name: string | null; avatarUrl: string | null };
    }
  | { kind: "guardian"; name: string | null; avatarUrl: string | null }
  | { kind: "visitor"; accountId: string; name: string | null; avatarUrl: string | null };

// "workflow-planner" → "Workflow Planner". Canonical runtime ids are reduced
// to their app-local name first, so `dream:skill-review` stays a runtime value
// and renders as "Skill Review" in chat labels.
export function prettyAgentName(name: string): string {
  const separator = name.indexOf(":");
  const localName = separator < 0 ? name : name.slice(separator + 1);
  return localName
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The configured main-agent name, or the dashboard's role label when empty. */
export function mainAgentDisplayName(configuredName: unknown, fallback = "Rome"): string {
  return (typeof configuredName === "string" ? configuredName.trim() : "") || fallback;
}
