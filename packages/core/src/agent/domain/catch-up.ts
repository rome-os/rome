import type { MessageReplyReference } from "@rome-os/app-runtime";
import type { PromptMessage, UnseenMessage } from "./prompt-facts.js";
import { currentMessageSection, replyContextLine, replyContextSection } from "./reply-context.js";

/** How many of the messages the agent has not seen a turn's prompt carries.
 *  The rest are counted, not shown. */
const CATCH_UP_LIMIT = 20;

/** One message of the context a turn's prompt opens with. */
interface ContextMessage {
  id: string;
  sender: string | null;
  who?: string | null;
  text: string;
  createdAt?: Date;
}

function contextMessage(message: PromptMessage): ContextMessage {
  return {
    id: String(message.id),
    sender: message.sender,
    who: message.who,
    text: message.text,
    createdAt: message.at,
  };
}

/** The name a message showed, without square brackets, which mark who Rome
 *  knows the sender to be: a name a sender picks never reads as that. */
function shownName(sender: string | null | undefined): string | null {
  return sender?.replace(/[[\]]/g, "").trim() || null;
}

/** `text` with its markup escaped, so nothing a sender writes closes the
 *  block it sits in. */
function escapeMarkup(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A message's text as one context line reads it. Its later lines are
 *  indented, so none of them reads as another message. */
function shownText(text: string): string {
  return escapeMarkup(text).replace(/\r?\n/g, "\n  ");
}

function contextLine(message: ContextMessage): string {
  const name = escapeMarkup((shownName(message.sender) ?? "Unknown sender").replace(/\s+/g, " "));
  const who = message.who?.trim();
  return replyContextLine({
    createdAt: message.createdAt,
    sender: who ? `${name} [${who}]` : name,
    text: shownText(message.text),
  });
}

/**
 * A turn's prompt with what the agent catches up on ahead of it: the messages
 * said where its session stands that it has not seen, the last 20 shown and
 * the rest counted, after the message that started the thread when a message
 * of Rome's quotes one from outside it, then the message the turn replies to,
 * then the turn's own message with who said it. The message replied to is not
 * repeated among the unseen ones. With nothing to catch up on and no sender
 * named, the prompt is unchanged.
 */
export function catchUpPrompt(
  prompt: string,
  facts: {
    unseen: readonly UnseenMessage[];
    /** The message the turn replies to, as Rome holds it, or null when Rome holds none. */
    quoted?: PromptMessage | null;
    /** The platform's reference to the message the turn replies to. */
    replyTo?: MessageReplyReference;
    /** The message the turn answers, as Rome holds it, or null when Rome holds none. */
    current?: PromptMessage | null;
  },
): string {
  const { unseen } = facts;
  const shown = unseen.slice(-CATCH_UP_LIMIT);
  // Rome's first message in a thread quotes the message that started it, said
  // in the chat outside the thread. No message in the thread is a starter.
  const threadStarter =
    unseen.find((message) => message.fromRome && message.quotesOutside)?.quoted ?? null;
  const repliedTo: ContextMessage | null = facts.quoted
    ? contextMessage(facts.quoted)
    : facts.replyTo?.content
      ? {
          id: `runtime-reply:${facts.replyTo.messageId}`,
          sender: facts.replyTo.senderName ?? null,
          text: facts.replyTo.content,
        }
      : null;
  const omitted = unseen.length - shown.length;
  const notifications = [
    ...(threadStarter ? [contextMessage(threadStarter)] : []),
    ...shown.map(contextMessage),
  ].filter(
    (message) =>
      message.id !== repliedTo?.id && !(facts.current && message.id === String(facts.current.id)),
  );
  const from = facts.current
    ? { name: shownName(facts.current.sender), who: facts.current.who?.trim() || null }
    : null;

  const sections: string[] = [];
  if (notifications.length > 0 || omitted > 0) {
    sections.push(
      "<conversation_context>",
      ...(omitted > 0 ? [`[${omitted} earlier messages omitted]`] : []),
      ...notifications.map(contextLine),
      "</conversation_context>",
    );
  }
  if (repliedTo) sections.push(...replyContextSection(contextLine(repliedTo)));
  if (sections.length === 0 && !from?.name && !from?.who) return prompt;
  sections.push(...currentMessageSection(prompt, from));
  return sections.join("\n");
}
