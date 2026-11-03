// What a channel that shows only text refuses to send, by the contract on the
// SDK's `ChannelSend.send`: it never drops what it cannot show and reports
// the rest as sent.

import { ChannelSendRefused, type OutgoingMessage } from "@rome-os/app-runtime";

/**
 * The text a channel named `channel`, which shows text and no other part,
 * sends for `message`: its `text` when it has any, else its text parts.
 * Refuses a part of any other type, and a message with no text and no
 * attachment.
 */
export function textToSend(channel: string, message: OutgoingMessage): string {
  refuseUnshownParts(channel, message);
  const parts = message.parts ?? [];
  const text = message.text?.trim()
    ? message.text
    : parts.flatMap((part) => (part.type === "text" ? [part.content] : [])).join("\n\n");
  if (text.trim()) return text;
  if (!message.attachments?.length) {
    throw new ChannelSendRefused("empty", `A message to ${channel} needs text or an attachment`);
  }
  // Blank text says nothing, so the attachments go out alone.
  return "";
}

/** Refuses any attachment, on a channel named `channel` that carries none. */
export function refuseAttachments(channel: string, message: OutgoingMessage): void {
  if (message.attachments?.length) {
    throw new ChannelSendRefused(
      "attachment_unsupported",
      `${channel} carries no attachments; send the files another way`,
    );
  }
}

/** The message `replyTo` names on a channel named `channel` that numbers its
 *  messages, or undefined when it names none. Refuses an id that is not one
 *  of the channel's numbers. */
export function numericReplyTo(channel: string, replyTo: string | undefined): number | undefined {
  if (replyTo === undefined) return undefined;
  const id = Number(replyTo);
  if (!replyTo.trim() || !Number.isSafeInteger(id)) {
    throw new ChannelSendRefused(
      "reply_unaddressable",
      `${channel} cannot answer message "${replyTo}"`,
    );
  }
  return id;
}

/** Refuses a part other than text, on a channel named `channel` that shows
 *  text only. */
export function refuseUnshownParts(channel: string, message: OutgoingMessage): void {
  const parts = message.parts ?? [];
  const unshown = [...new Set(parts.filter((part) => part.type !== "text").map((p) => p.type))];
  if (unshown.length > 0) {
    throw new ChannelSendRefused(
      "part_unsupported",
      `${channel} shows text only and cannot send ${unshown.join(", ")} parts`,
    );
  }
}

/** Refuses any reply, on a channel named `channel` that cannot quote. */
export function refuseReplies(channel: string, message: OutgoingMessage): void {
  if (message.replyToMessageId !== undefined) {
    throw new ChannelSendRefused(
      "reply_unaddressable",
      `${channel} cannot quote a message, so it cannot send a reply to one`,
    );
  }
}
