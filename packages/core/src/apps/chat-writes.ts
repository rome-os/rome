// What an app says and hears in the chats Rome's sessions stand in, kept in
// Chats: the writes of the SDK's `ChatRepository` over Chats' messages,
// Agents' speakers and the turns they link. Vocabulary: docs/domains/chats.md
// and docs/domains/participation.md.
//
// An app names a session and the platform's ids; this file turns them into
// the speaker, the line and its key. Nothing hands these to apps yet: the
// Chats switch adds them to the app repositories and moves the inbox and
// `send_message` onto them.

import type {
  Channel,
  ChatRepository,
  MessagePart,
  OutgoingAttachment,
} from "@rome-os/app-runtime";
import {
  stripHostOnlyPartsFromContent,
  withoutHostOnlyParts,
} from "../channels/host-only-parts.js";
import { messageContentText } from "../channels/messages-agent.js";
import { htmlToMarkdown } from "../lib/email-markdown.js";
import type { ChatRepository as Chats } from "../chats/storage/chat-repository.js";
import { partsText } from "../chats/storage/message.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { placeIn } from "../chats/storage/place.js";
import type { ChatAdapters } from "../connections/chat-adapter.js";
import {
  emailOf,
  type EmailOutbound,
  type EmailRecipients,
} from "../connections/email-chat-adapter.js";
import type { SpeakerAt, SpeakerLines } from "../connections/speaker-lines.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import type { SpeakerReplies } from "../sessions/speaker-replies.js";
import type { Speakers } from "../sessions/speakers.js";
import type { TurnLinks } from "../sessions/turn-links.js";
import { createLogger } from "../logger.js";

const log = createLogger("app-chat-writes");

export type ChatWrites = Pick<
  Required<ChatRepository>,
  "addMessage" | "promoteMessageToUser" | "send" | "sendEmail"
>;

export interface AppChatWritesDeps {
  /** Moves a session's activity up when a line reaches its chat. */
  webchatRepo: Pick<WebChatRepository, "advanceSessionActivity">;
  chats: Pick<Chats, "start">;
  messages: Pick<MessageRepository, "record" | "send" | "chatHolding">;
  speakers: Pick<Speakers, "speakerOf">;
  /** What a speaker says, recorded and linked to its turn. */
  replies: Pick<SpeakerReplies, "send">;
  links: Pick<TurnLinks, "prompt" | "answer">;
  /** The lines an app names by the platform's ids. */
  lines: Pick<SpeakerLines, "idIn" | "keyIn" | "platformIdIn" | "recorded">;
  adapters: Pick<ChatAdapters, "of" | "addressAt" | "accountOn">;
  /** The live channel named `name`, whose adapter a speaker says its
   *  messages through, or null when Rome holds none by that name. */
  channel(name: string): Channel | null;
  /** The session at a channel address, standing in its chat as the
   *  channel's account's speaker: main's in an email thread. It has to put
   *  the session in Chats, as `openChannelChat` given speakers does, since
   *  every write here finds the session there. */
  open: ChatRepository["ensureChannelChat"];
}

export function appChatWrites(deps: AppChatWritesDeps): ChatWrites {
  const channelNamed = (name: string): Channel => {
    const channel = deps.channel(name);
    if (!channel) throw new Error(`No channel named "${name}"`);
    return channel;
  };
  const speakerOf = (sessionId: string) => {
    const speaker = deps.speakers.speakerOf(sessionId);
    if (!speaker) throw new Error(`Session ${sessionId} stands in no chat`);
    return speaker;
  };

  /** The address of the email thread holding the email the provider calls
   *  `messageId`. Refuses one Rome holds no thread for, since sending it as
   *  a new email would answer nothing. */
  const threadHolding = (channelName: string, messageId: string): string => {
    const account = deps.adapters.accountOn(channelName);
    const chat = deps.messages.chatHolding(account.platform, messageId);
    if (!chat) {
      throw new Error(`Rome holds no email thread with message ${messageId}. No email was sent.`);
    }
    return deps.adapters.addressAt(channelName, placeIn(chat));
  };

  /**
   * Open a thread to `recipients` and say `out` there as main: its first
   * message, which starts it. Main joins the thread once the provider took
   * the message, so a refused email leaves no session or line. The email
   * went out once the provider took it, so a failure to join after that is
   * logged and the send still answers.
   */
  const startThread = async (
    channel: Channel,
    recipients: EmailRecipients,
    subject: string,
    out: Omit<EmailOutbound, "replyTo">,
    recorded: readonly MessagePart[],
    turnId: string | undefined,
  ) => {
    const adapter = emailOf(deps.adapters, channel);
    const key = adapter.open(recipients, subject);
    const chat = deps.chats.start(key, "group", subject || null).ref;
    const account = adapter.account;
    const sent = await deps.messages.send(
      {
        direction: "fromRome",
        place: placeIn(chat),
        saidBy: { account, agent: "main" },
        parts: recorded,
      },
      async (target) => ({ key: (await adapter.send(target.chat, null, out)).key }),
    );
    const threadId = deps.adapters.addressAt(channel.name, placeIn(chat));
    try {
      const session = await deps.open({
        channel: channel.name,
        threadId,
        agentName: "main",
        threadType: "group",
        ...(subject ? { threadName: subject } : {}),
      });
      if (sent.id !== null && turnId) deps.links.answer(sent.id, session.id, turnId);
    } catch (error) {
      log.error("an email thread Rome started went out, but main could not join it", {
        chat: chat.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      messageId: deps.lines.platformIdIn({ place: placeIn(chat), accountId: account.id }, sent.key),
      threadId,
    };
  };

  return {
    // The line is recorded where the session stands, keyed as its account
    // hears the platform's message, so the adapter hearing it too records it
    // once. A prompt is linked to the session.
    async addMessage(input) {
      const speaker = speakerOf(input.sessionId);
      const keyOf = (platformMessageId: string) => deps.lines.keyIn(speaker, platformMessageId);
      const recorded = deps.messages.record({
        direction: "toRome",
        key: keyOf(input.platformMessageId),
        place: speaker.place,
        saidBy: {
          account: { platform: speaker.place.chat.platform, id: input.senderId ?? "" },
          ...(input.senderName === undefined ? {} : { name: input.senderName }),
        },
        body: { text: messageContentText(input.content) ?? "" },
        ...(input.replyToPlatformMessageId === undefined
          ? {}
          : { replyTo: keyOf(input.replyToPlatformMessageId) }),
        at: input.createdAt ?? new Date(),
      });
      if (!recorded) {
        // Heard already, as through the adapter: still the session's prompt
        // when the app says so.
        const id = deps.lines.idIn(speaker, input.platformMessageId);
        if (id !== null && input.role === "user") deps.links.prompt(id, input.sessionId);
        return { inserted: false };
      }
      if (input.role === "user") deps.links.prompt(recorded.id, input.sessionId);
      deps.webchatRepo.advanceSessionActivity(input.sessionId, recorded.at);
      return { inserted: true };
    },

    async promoteMessageToUser(sessionId, platformMessageId) {
      const line = await deps.lines.recorded(sessionId, platformMessageId);
      if (line) deps.links.prompt(line.id, sessionId);
    },

    async send(input) {
      const channel = channelNamed(input.channel);
      const parts = input.parts?.length ? withoutHostOnlyParts(input.parts) : undefined;
      // An app quotes by the platform's id, which names a line of the
      // session's chat.
      const speaker = input.replyToPlatformMessageId ? speakerOf(input.sessionId) : null;
      const sent = await deps.replies.send(
        input.sessionId,
        channel,
        {
          // A channel that shows text alone shows this, so parts-only sends
          // say their text parts.
          text: input.text ?? (parts ? partsText(parts) : ""),
          ...(parts ? { parts } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...replyToIn(deps, speaker, input.replyToPlatformMessageId),
        },
        {
          ...(input.knownToProvider && input.turnId ? { turnId: input.turnId } : {}),
          recorded: input.content
            ? recordedOf(input.content)
            : withNotes(parts ?? [{ type: "text", content: input.text ?? "" }], input.attachments),
        },
      );
      if (!sent) throw new Error(`Session ${input.sessionId} stands in no chat`);
      const messageId = deps.lines.platformIdIn(sent.speaker, sent.sent);
      return messageId ? { messageId } : {};
    },

    async sendEmail(input) {
      const channel = channelNamed(input.channel);
      const parts = input.parts?.length ? withoutHostOnlyParts(input.parts) : undefined;
      const recorded = input.content ? recordedOf(input.content) : undefined;
      const { to, cc, bcc, subject, html, inReplyToMessageId } = input.email;
      if (inReplyToMessageId !== undefined && !inReplyToMessageId.trim()) {
        throw new Error("Email replyToMessageId must not be blank. No email was sent.");
      }
      // An email's body is its text, else the text of its parts. An
      // HTML-only email goes on record as the text its HTML reads as.
      const text = input.text ?? (parts ? partsText(parts) : "");
      const shown = text.trim() || (html ? htmlToMarkdown(html, true).trim() : "");
      const onRecord: readonly MessagePart[] = recorded ??
        parts ?? [{ type: "text", content: shown }];
      const out: Omit<EmailOutbound, "replyTo"> = {
        text,
        ...(parts ? { parts } : {}),
        ...(html ? { html } : {}),
      };
      const turnId = input.knownToProvider ? input.turnId : undefined;
      // A reply names its thread by the email it answers, when the caller
      // names neither.
      const threadId =
        input.threadId ??
        (input.sessionId || inReplyToMessageId === undefined
          ? undefined
          : threadHolding(channel.name, inReplyToMessageId));
      if (!threadId && !input.sessionId) {
        return await startThread(
          channel,
          { to: to ?? [], ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}) },
          subject?.trim() ?? "",
          out,
          onRecord,
          turnId,
        );
      }
      // An email thread is a group chat, main's unless the caller names its
      // session.
      const sessionId =
        input.sessionId ??
        (
          await deps.open({
            channel: input.channel,
            // Checked above: a send names a thread or a session.
            threadId: threadId as string,
            agentName: "main",
            threadType: "group",
          })
        ).id;
      const speaker = inReplyToMessageId ? speakerOf(sessionId) : null;
      const reply: Omit<EmailOutbound, "replyTo"> = {
        ...out,
        ...(cc?.length ? { cc } : {}),
        ...(bcc?.length ? { bcc } : {}),
      };
      const sent = await deps.replies.send(
        sessionId,
        channel,
        { ...reply, ...replyToIn(deps, speaker, inReplyToMessageId) },
        { ...(turnId ? { turnId } : {}), recorded: onRecord },
      );
      if (!sent) throw new Error(`Session ${sessionId} stands in no chat`);
      return {
        messageId: deps.lines.platformIdIn(sent.speaker, sent.sent),
        threadId: deps.adapters.addressAt(input.channel, sent.speaker.place),
      };
    },
  };
}

/** The quote of the line the platform calls `platformMessageId` where
 *  `speaker` stands: by its id when Rome holds it, else by its key. */
function replyToIn(
  deps: Pick<AppChatWritesDeps, "lines">,
  speaker: SpeakerAt | null,
  platformMessageId: string | undefined,
): { replyTo?: number | { key: string } } {
  if (!speaker || !platformMessageId) return {};
  const id = deps.lines.idIn(speaker, platformMessageId);
  return { replyTo: id ?? { key: deps.lines.keyIn(speaker, platformMessageId) } };
}

/** `parts` with a note for each attachment, which Chats keeps no file of. */
function withNotes(
  parts: readonly MessagePart[],
  attachments: readonly OutgoingAttachment[] | undefined,
): MessagePart[] {
  const notes = (attachments ?? []).map(
    (attachment) => `[${attachment.type}${attachment.caption ? `: ${attachment.caption}` : ""}]`,
  );
  if (!notes.length) return [...parts];
  const said = parts.filter((part) => part.type !== "text" || part.content.trim());
  return [...said, { type: "text", content: notes.join("\n") }];
}

/** An app's `content`, the line as it goes on record, without the parts only
 *  the host may author, so a forged routine card never reaches the chat. */
function recordedOf(content: string): MessagePart[] {
  return JSON.parse(stripHostOnlyPartsFromContent(content)) as MessagePart[];
}
