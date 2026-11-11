// What an app says and hears in the chats Rome's sessions stand in, kept in
// Chats: the writes of the SDK's `ChatRepository` over Chats' messages,
// Agents' speakers and the turns they link. Vocabulary: docs/domains/chats.md
// and docs/domains/participation.md.
//
// An app names a session and the platform's ids; this file turns them into
// the speaker, the message and its key. Nothing hands these to apps yet: the
// Chats switch adds them to the app repositories and moves the inbox and
// `send_message` onto them.

import { partsWithText } from "../chats/storage/message.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import type {
  Channel,
  ChatId,
  ChatRepository,
  MessagePart,
  OutgoingAttachment,
} from "@rome-os/app-runtime";
import { stripHostOnlyPartsFromContent } from "../chats/host-only-parts.js";
import { v7 as uuidv7 } from "uuid";
import { messageContentText } from "../chats/history/messages-agent.js";
import { htmlToMarkdown } from "../connections/kinds/email/email-markdown.js";
import type { ChatRepository as Chats } from "../chats/storage/chat-repository.js";
import type { MessageRepository } from "../chats/storage/message-repository.js";
import { type ChatRef, placeIn } from "../chats/storage/place.js";
import { type ChatAdapters, platformIdOfMessage } from "../connections/chat-adapter.js";
import {
  emailOf,
  type EmailOutbound,
  type EmailRecipients,
} from "../connections/email-chat-adapter.js";
import type { SpeakerAt, SpeakerMessages } from "../connections/speaker-messages.js";
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
  /** Moves a session's activity up when a message reaches its chat. */
  webchatRepo: Pick<WebChatRepository, "advanceSessionActivity">;
  chats: Pick<Chats, "start">;
  messages: Pick<MessageRepository, "record" | "send" | "chatHolding">;
  speakers: Pick<Speakers, "speakerOf">;
  /** What a speaker says, recorded and linked to its turn. */
  replies: Pick<SpeakerReplies, "send" | "agentOf">;
  links: Pick<TurnLinks, "prompt" | "answer">;
  /** The messages an app names by the platform's ids. */
  lines: Pick<SpeakerMessages, "idIn" | "keyIn" | "platformIdIn" | "recorded">;
  adapters: Pick<ChatAdapters, "of" | "keyOf" | "accountOn">;
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

  /** Moves the session's activity to `at`, once a send went out. The send
   *  already happened, so a failure here is logged, not thrown. */
  const active = (sessionId: string, at: Date) => {
    try {
      deps.webchatRepo.advanceSessionActivity(sessionId, at);
    } catch (error) {
      log.error("a send went out, but its session's activity could not move", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** The platform's id for a message `speaker` says, as a function of the
   *  message's key. It reads storage now, before a send, so turning a receipt
   *  into an id never fails a send the platform took. */
  const receiptOf = (speaker: SpeakerAt) => {
    const chat = deps.adapters.keyOf(speaker.place.chat);
    return (messageKey: string) => platformIdOfMessage(chat, speaker.accountId, messageKey);
  };

  /** The provider's address for the email thread `chat`. Asks the email
   *  adapter, which keeps the address of a thread it started even when
   *  storing it failed. */
  const threadAddressOf = (channel: Channel, chat: ChatRef): string =>
    emailOf(deps.adapters, channel).threadAddress(deps.adapters.keyOf(chat).externalId);

  /** The email thread holding the email the provider calls `messageId`, or
   *  null when Rome holds none. */
  const threadHolding = (channel: Channel, messageId: string): ChatRef | null => {
    const account = deps.adapters.accountOn(channel.name);
    return deps.messages.chatHolding(account.platform, messageId);
  };

  /**
   * Reply to the email the provider calls `messageId`, which Rome holds no
   * thread for, as one fetched from the mailbox directly. The provider sends
   * a reply into the thread of the email it answers, so the reply goes out
   * through the channel's port, and Rome learns the thread from its receipt:
   * main joins it there, and the reply is recorded as main's. The email went
   * out once the provider took it, so a failure to record it after that is
   * logged and the send still answers.
   */
  const replyUnheld = async (
    channel: Channel,
    messageId: string,
    out: Omit<EmailOutbound, "replyTo">,
    recorded: readonly MessagePart[],
    turnId: string | undefined,
    agent: string,
  ) => {
    if (!channel.send) throw new Error(`Channel "${channel.name}" cannot send`);
    const receipt = await channel.send.send("" as ChatId, {
      kind: "email",
      text: out.text,
      ...(out.parts ? { parts: [...out.parts] } : {}),
      ...(out.html ? { html: out.html } : {}),
      ...(out.cc?.length ? { cc: [...out.cc] } : {}),
      ...(out.bcc?.length ? { bcc: [...out.bcc] } : {}),
      ...(turnId ? { turnId } : {}),
      inReplyToMessageId: messageId,
    });
    const sentId = receipt?.messageId?.trim() || null;
    const threadId = receipt?.chatId?.trim() ?? "";
    if (!threadId) {
      log.error("an email reply went out, but the provider named no thread to record it in", {
        channel: channel.name,
        inReplyTo: messageId,
      });
      return { messageId: sentId, threadId };
    }
    try {
      const session = await deps.open({
        channel: channel.name,
        threadId,
        agentName: "main",
        threadType: "group",
      });
      const speaker = speakerOf(session.id);
      const sent = await deps.messages.send(
        {
          direction: "fromRome",
          place: speaker.place,
          saidBy: {
            account: { platform: speaker.place.chat.platform, id: speaker.accountId },
            agent,
          },
          parts: recorded,
          replyTo: { key: deps.lines.keyIn(speaker, messageId) },
        },
        // Delivered already: the receipt keys the message.
        async () => ({
          key: sentId ? deps.lines.keyIn(speaker, sentId) : `rome:${uuidv7()}`,
        }),
      );
      if (sent.id !== null && turnId) deps.links.answer(sent.id, session.id, turnId);
      active(session.id, sent.at);
    } catch (error) {
      log.error("an email reply went out, but could not be recorded", {
        channel: channel.name,
        thread: threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { messageId: sentId, threadId };
  };

  /**
   * Open a thread to `recipients` and say `out` there as main: its first
   * message, which starts it. Main joins the thread once the provider took
   * the message, so a refused email leaves no session or message. The email
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
    agent: string,
  ) => {
    const adapter = emailOf(deps.adapters, channel);
    const key = adapter.open(recipients, subject);
    const chat = deps.chats.start(key, "group", subject || null).ref;
    const account = adapter.account;
    const sent = await deps.messages.send(
      {
        direction: "fromRome",
        place: placeIn(chat),
        saidBy: { account, agent },
        parts: recorded,
      },
      async (target) => ({ key: (await adapter.send(target.chat, null, out)).key }),
    );
    // The adapter keeps the thread's address in memory, so reading it after
    // the send cannot fail it.
    const threadId = adapter.threadAddress(key.externalId);
    try {
      const session = await deps.open({
        channel: channel.name,
        threadId,
        agentName: "main",
        threadType: "group",
        ...(subject ? { threadName: subject } : {}),
      });
      if (sent.id !== null && turnId) deps.links.answer(sent.id, session.id, turnId);
      active(session.id, sent.at);
    } catch (error) {
      log.error("an email thread Rome started went out, but main could not join it", {
        chat: chat.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      messageId: platformIdOfMessage(key, account.id, sent.key),
      threadId,
    };
  };

  return {
    // The message is recorded where the session stands, keyed as its account
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
        ...partsIn(input.content),
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
      const parts = input.parts?.length ? input.parts : undefined;
      // An app quotes by the platform's id, which names a message of the
      // session's chat.
      const speaker = speakerOf(input.sessionId);
      const receipt = receiptOf(speaker);
      const sent = await deps.replies.send(
        input.sessionId,
        channel,
        {
          // A channel that shows text alone reads parts-only sends by their
          // parts, in their order.
          text: input.text ?? "",
          ...(parts ? { parts } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...replyToIn(deps, speaker, input.replyToPlatformMessageId),
        },
        {
          ...(input.knownToProvider && input.turnId ? { turnId: input.turnId } : {}),
          ...agentOf(deps, input.turnId),
          recorded: input.content
            ? recordedOf(input.content)
            : withNotes(
                parts
                  ? partsWithText(input.text, parts)
                  : [{ type: "text", content: input.text ?? "" }],
                input.attachments,
              ),
        },
      );
      if (!sent) throw new Error(`Session ${input.sessionId} stands in no chat`);
      active(input.sessionId, sent.at);
      const messageId = receipt(sent.sent);
      return messageId ? { messageId } : {};
    },

    async sendEmail(input) {
      const channel = channelNamed(input.channel);
      // Refused before anything goes out on a channel that sends no email.
      emailOf(deps.adapters, channel);
      const parts = input.parts?.length ? input.parts : undefined;
      // Composed content with nothing in it, as an HTML-only email's, says
      // nothing: the email goes on record as its HTML reads.
      const composed = input.content ? recordedOf(input.content) : undefined;
      const recorded = composed?.length ? composed : undefined;
      const { to, cc, bcc, subject, html, inReplyToMessageId } = input.email;
      // An email's body is its text, else its parts, which the email port
      // reads in their order. An HTML-only email goes on record as the text
      // its HTML reads as.
      const text = input.text ?? "";
      const shown = text.trim() || (html ? htmlToMarkdown(html, true).trim() : "");
      const onRecord: readonly MessagePart[] =
        recorded ?? (parts ? partsWithText(input.text, parts) : [{ type: "text", content: shown }]);
      const out: Omit<EmailOutbound, "replyTo"> = {
        text,
        ...(parts ? { parts } : {}),
        ...(html ? { html } : {}),
      };
      const turnId = input.knownToProvider ? input.turnId : undefined;
      // A reply goes to the thread holding the email it answers, since the
      // provider sends it there. A caller that names another thread or
      // session is refused before anything goes out.
      const held =
        inReplyToMessageId === undefined ? undefined : threadHolding(channel, inReplyToMessageId);
      if (held === null) {
        // A blank id names no email, so nothing answers it.
        if (!inReplyToMessageId?.trim()) {
          throw new Error(
            `Rome holds no email thread with message ${inReplyToMessageId}. No email was sent.`,
          );
        }
        // The provider sends a reply into the thread of the email it answers,
        // whatever thread or session the caller names, as the email port
        // always has: the reply is recorded where the provider's receipt says.
        return await replyUnheld(
          channel,
          inReplyToMessageId,
          {
            ...out,
            ...(cc?.length ? { cc } : {}),
            ...(bcc?.length ? { bcc } : {}),
          },
          onRecord,
          turnId,
          agentOf(deps, input.turnId).agent ?? "main",
        );
      }
      if (
        held &&
        input.threadId !== undefined &&
        threadAddressOf(channel, held) !== input.threadId
      ) {
        throw new Error(
          `Email ${inReplyToMessageId} is not in thread ${input.threadId}. No email was sent.`,
        );
      }
      if (held && input.sessionId && speakerOf(input.sessionId).place.chat.id !== held.id) {
        throw new Error(
          `Email ${inReplyToMessageId} is not in session ${input.sessionId}'s thread. No email was sent.`,
        );
      }
      const threadId =
        input.threadId ?? (input.sessionId || !held ? undefined : threadAddressOf(channel, held));
      if (!threadId && !input.sessionId) {
        return await startThread(
          channel,
          { to: to ?? [], ...(cc ? { cc } : {}), ...(bcc ? { bcc } : {}) },
          subject?.trim() ?? "",
          out,
          onRecord,
          turnId,
          agentOf(deps, input.turnId).agent ?? "main",
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
      const speaker = speakerOf(sessionId);
      const address = speaker.place.threadId ?? threadAddressOf(channel, speaker.place.chat);
      if (input.threadId !== undefined && address !== input.threadId) {
        throw new Error(
          `Session ${sessionId} is not in thread ${input.threadId}. No email was sent.`,
        );
      }
      const receipt = receiptOf(speaker);
      const reply: Omit<EmailOutbound, "replyTo"> = {
        ...out,
        ...(cc?.length ? { cc } : {}),
        ...(bcc?.length ? { bcc } : {}),
      };
      const sent = await deps.replies.send(
        sessionId,
        channel,
        { ...reply, ...replyToIn(deps, speaker, inReplyToMessageId) },
        { ...(turnId ? { turnId } : {}), ...agentOf(deps, input.turnId), recorded: onRecord },
      );
      if (!sent) throw new Error(`Session ${sessionId} stands in no chat`);
      active(sessionId, sent.at);
      return { messageId: receipt(sent.sent), threadId: address };
    },
  };
}

/** The quote of the message the platform calls `platformMessageId` where
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

/** An app's `content`, the message as it goes on record, without the parts only
 *  the host may author, so a forged routine card never reaches the chat. */
/** The parts an app's message content holds, host-only ones left out, when
 *  it holds a list of them. */
function partsIn(content: string): { parts?: MessagePart[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripHostOnlyPartsFromContent(content));
  } catch {
    return {};
  }
  return Array.isArray(parsed) && parsed.length ? { parts: parsed as MessagePart[] } : {};
}

function recordedOf(content: string): MessagePart[] {
  return JSON.parse(stripHostOnlyPartsFromContent(content)) as MessagePart[];
}

/** The agent the turn sending runs, for a send that may not answer it: as
 *  noted where the turn started or where a worker asked main to run it, else
 *  as the action running in that turn names it. */
function agentOf(deps: AppChatWritesDeps, turnId: string | undefined): { agent?: string } {
  const running = actionExecutionContext.getStore();
  const agent =
    deps.replies.agentOf(turnId) ??
    (turnId !== undefined && running?.turnId === turnId ? running.agentName : undefined);
  return agent === undefined ? {} : { agent };
}
