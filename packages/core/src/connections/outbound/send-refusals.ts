// What a channel that shows only text refuses to send, by the contract on the
// SDK's `ChannelSend.send`: it never drops what it cannot show and reports
// the rest as sent.

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { SendRefused, type OutgoingAttachment, type OutgoingMessage } from "@rome-os/app-runtime";

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
    throw new SendRefused("empty", `A message to ${channel} needs text or an attachment`);
  }
  // Blank text says nothing, so the attachments go out alone.
  return "";
}

/** Refuses any attachment, on a channel named `channel` that carries none. */
export function refuseAttachments(channel: string, message: OutgoingMessage): void {
  if (message.attachments?.length) {
    throw new SendRefused(
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
    throw new SendRefused("reply_unaddressable", `${channel} cannot answer message "${replyTo}"`);
  }
  return id;
}

/** Refuses a part other than text, on a channel named `channel` that shows
 *  text only. */
export function refuseUnshownParts(channel: string, message: OutgoingMessage): void {
  const parts = message.parts ?? [];
  const unshown = [...new Set(parts.filter((part) => part.type !== "text").map((p) => p.type))];
  if (unshown.length > 0) {
    throw new SendRefused(
      "part_unsupported",
      `${channel} shows text only and cannot send ${unshown.join(", ")} parts`,
    );
  }
}

/** Refuses any reply, on a channel named `channel` that cannot quote. */
export function refuseReplies(channel: string, message: OutgoingMessage): void {
  if (message.replyToMessageId !== undefined) {
    throw new SendRefused(
      "reply_unaddressable",
      `${channel} cannot quote a message, so it cannot send a reply to one`,
    );
  }
}

/** What a channel carries of attachments: the types it sends, and whether a
 *  source may be a web address the platform fetches rather than a file on
 *  disk. */
export interface AttachmentCarriage {
  readonly types: readonly OutgoingAttachment["type"][];
  readonly urls: boolean;
}

/** Every attachment type the SDK names. */
export const ALL_ATTACHMENT_TYPES: readonly OutgoingAttachment["type"][] = [
  "image",
  "video",
  "audio",
  "document",
];

const WEB_ADDRESS = /^https?:\/\//i;

/**
 * The attachments `message` carries, each one checked before anything is sent,
 * so a send never goes out in part. Refuses as `attachment_unsupported` an
 * attachment of a type `carries` leaves out, one with no source or a caption
 * that is not text, a web address on a channel that sends files only, and a
 * file that is not on disk.
 */
export async function attachmentsToSend(
  channel: string,
  message: OutgoingMessage,
  carries: AttachmentCarriage,
): Promise<readonly OutgoingAttachment[]> {
  const attachments = message.attachments ?? [];
  for (const attachment of attachments) {
    const refuse = (why: string): never => {
      throw new SendRefused("attachment_unsupported", `${channel} ${why}`);
    };
    const { type, source, caption } = attachment as Partial<OutgoingAttachment>;
    if (!carries.types.includes(type as OutgoingAttachment["type"])) {
      refuse(`cannot send an attachment of type ${JSON.stringify(type)}`);
    }
    if (typeof source !== "string" || !source.trim()) {
      refuse("cannot send an attachment that names no file");
    }
    if (caption !== undefined && typeof caption !== "string") {
      refuse("cannot send an attachment whose caption is not text");
    }
    const path = source as string;
    if (WEB_ADDRESS.test(path)) {
      if (!carries.urls) refuse(`sends files from disk, not web addresses such as ${path}`);
      continue;
    }
    const file = await stat(path).catch(() => null);
    if (!file?.isFile()) refuse(`cannot send ${path}: no file is there`);
    const readable = await access(path, constants.R_OK).then(
      () => true,
      () => false,
    );
    if (!readable) refuse(`cannot send ${path}: Rome may not read it`);
  }
  return attachments;
}

/** An email's Message-ID, `local@domain`, in angle brackets or without. */
export const EMAIL_MESSAGE_ID = /^(?:<[^\s<>@]+@[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+)$/;

/** Refuses a `replyTo` that is not of `pattern`, the shape of a message id on
 *  a channel named `channel`, and answers it otherwise. */
export function replyToShaped(
  channel: string,
  replyTo: string | undefined,
  pattern: RegExp,
): string | undefined {
  if (replyTo === undefined) return undefined;
  if (typeof replyTo !== "string" || !pattern.test(replyTo)) {
    throw new SendRefused(
      "reply_unaddressable",
      `${channel} cannot answer message ${JSON.stringify(replyTo)}: it is not one of its message ids`,
    );
  }
  return replyTo;
}
