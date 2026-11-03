// What an app says and hears in the chats Rome's sessions stand in, kept in
// Chats: the writes of the SDK's `ChatRepository` over Chats' messages,
// Agents' speakers and the turns they link. Vocabulary: docs/domains/chats.md
// and docs/domains/participation.md.
//
// An app names a session and the platform's ids; this file turns them into
// the speaker, the line and its key. Nothing hands these to apps yet: the
// Chats switch adds them to the app repositories and moves the inbox and
// `send_message` onto them.

import type { Channel, ChatRepository, MessagePart } from "@rome-os/app-runtime";
import {
  stripHostOnlyPartsFromContent,
  withoutHostOnlyParts,
} from "../channels/host-only-parts.js";
import { messageContentText } from "../channels/messages-agent.js";
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

export type ChatWrites = Pick<
  Required<ChatRepository>,
  "addMessage" | "promoteMessageToUser" | "send" | "sendEmail"
>;

export interface AppChatWritesDeps {
  /** Moves a session's activity up when a line reaches its chat. */
  webchatRepo: Pick<WebChatRepository, "advanceSessionActivity">;
  chats: Pick<Chats, "start">;
  messages: Pick<MessageRepository, "record" | "send">;
  speakers: Pick<Speakers, "speakerOf">;
  /** What a speaker says, recorded and linked to its turn. */
  replies: Pick<SpeakerReplies, "send">;
  links: Pick<TurnLinks, "prompt" | "answer">;
  /** The lines an app names by the platform's ids. */
  lines: Pick<SpeakerLines, "idIn" | "keyIn" | "platformIdIn" | "recorded">;
  adapters: Pick<ChatAdapters, "of" | "addressAt">;
  /** The live channel named `name`, whose adapter a speaker says its
   *  messages through, or null when Rome holds none by that name. */
  channel(name: string): Channel | null;
  /** The session at a channel address, as the app repositories'
   *  `ensureChannelChat` opens it: main's in an email thread. */
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

  /**
   * Open a thread to `recipients` under `subject` and say `out` there as
   * main: its first message, which starts it. Main joins the thread once the
   * provider took the message, so a refused email leaves no session or line.
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
    let sessionId = "";
    const sent = await deps.messages.send(
      {
        direction: "fromRome",
        place: placeIn(chat),
        saidBy: { account, agent: "main" },
        parts: recorded,
      },
      async (target) => {
        const delivered = await adapter.send(target.chat, null, out);
        sessionId = (
          await deps.open({
            channel: channel.name,
            threadId: deps.adapters.addressAt(channel.name, placeIn(chat)),
            agentName: "main",
            threadType: "group",
            ...(subject ? { threadName: subject } : {}),
          })
        ).id;
        return { key: delivered.key };
      },
    );
    if (sent.id !== null && turnId) deps.links.answer(sent.id, sessionId, turnId);
    return {
      messageId: deps.lines.platformIdIn({ place: placeIn(chat), accountId: account.id }, sent.key),
      threadId: deps.adapters.addressAt(channel.name, placeIn(chat)),
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
      if (!recorded) return { inserted: false };
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
          text: input.text ?? "",
          ...(parts ? { parts } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...replyToIn(deps, speaker, input.replyToPlatformMessageId),
        },
        {
          ...(input.knownToProvider && input.turnId ? { turnId: input.turnId } : {}),
          ...(input.content ? { recorded: recordedOf(input.content) } : {}),
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
      // An email's body is its text, else the text of its parts.
      const text = input.text ?? (parts ? partsText(parts) : "");
      const out: Omit<EmailOutbound, "replyTo"> = {
        text,
        ...(parts ? { parts } : {}),
        ...(html ? { html } : {}),
      };
      const turnId = input.knownToProvider ? input.turnId : undefined;
      if (!input.threadId && !input.sessionId) {
        return await startThread(
          channel,
          { to: to ?? [], ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}) },
          subject?.trim() ?? "",
          out,
          recorded ?? parts ?? [{ type: "text", content: text }],
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
            threadId: input.threadId as string,
            agentName: "main",
            threadType: "group",
          })
        ).id;
      const speaker = inReplyToMessageId ? speakerOf(sessionId) : null;
      const sent = await deps.replies.send(
        sessionId,
        channel,
        { ...out, ...replyToIn(deps, speaker, inReplyToMessageId) },
        { ...(turnId ? { turnId } : {}), ...(recorded ? { recorded } : {}) },
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

/** An app's `content`, the line as it goes on record, without the parts only
 *  the host may author, so a forged routine card never reaches the chat. */
function recordedOf(content: string): MessagePart[] {
  return JSON.parse(stripHostOnlyPartsFromContent(content)) as MessagePart[];
}
