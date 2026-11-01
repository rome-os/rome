import type {
  AppRuntimeRepositories,
  AppSettingsRepository,
  Channel,
  ChatId,
  ChatRepository,
  GuardianProfileRepository,
  MessagePart,
  MessageReceipt,
  OutgoingMessage,
  WebChatRecapRepository,
} from "@rome-os/app-runtime";
import type { ChatRepository as ChatsByKey } from "../chats/chat-repository.js";
import { stripHostOnlyPartsFromContent } from "../channels/host-only-parts.js";
import { messageContentText } from "../channels/messages-agent.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { openChannelChat, type OpenChannelChatDeps } from "../sessions/open-seat.js";
import type { ChatAdapters } from "../chats/adapter.js";
import type { SeatLines } from "../channels/seat-lines.js";
import {
  emailOf,
  type EmailOutbound,
  type EmailRecipients,
} from "../channels/email-chat-adapter.js";
import { partsText } from "../chats/message.js";
import { placeIn } from "../chats/place.js";
import type { SeatReplies } from "../sessions/seat-replies.js";
import type { TurnLinks } from "../sessions/turn-links.js";
import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { applyGuardianProfile } from "../lib/guardian-profile.js";
import type { ChatReadModel } from "../webchat/chat-read-model.js";

export interface CreateAppRuntimeRepositoriesDeps {
  settingsRepo: SettingsRepository;
  webchatRepo: WebChatRepository;
  /** The chats a channel thread's first message starts. */
  chatRepo: Pick<ChatsByKey, "start">;
  /** Where a message an app hands over is put on record. */
  chatMessages: Pick<MessageRepository, "record" | "send">;
  /** What an app's seat says, recorded and linked to its turn. */
  replies: Pick<SeatReplies, "say" | "send">;
  /** Sends on a channel by its name, which an app's seat speaks through. */
  sendOn(channel: string, address: ChatId, message: OutgoingMessage): Promise<MessageReceipt>;
  links: Pick<TurnLinks, "prompt" | "answer">;
  /** The dashboard's read model, which an app's transcript read renders. */
  reads: Pick<ChatReadModel, "chatTranscript" | "sessionTranscript">;
  adapters: OpenChannelChatDeps["adapters"] & Pick<ChatAdapters, "of" | "addressAt">;
  /** The lines an app names by the platform's ids. */
  seatLines: Pick<SeatLines, "idIn" | "platformIdIn" | "recorded">;
  /** Present in the main process only, where the profile write can reschedule
   *  floating routines. An action worker gets no guardianProfile repository. */
  guardianProfile?: { db: DrizzleDb; reactivateFloating: () => Promise<void> };
}

export function createAppRuntimeRepositories(
  deps: CreateAppRuntimeRepositoriesDeps,
): AppRuntimeRepositories {
  const chats = createChatRepository(deps);
  return {
    settings: createAppSettingsRepository(deps.settingsRepo),
    webchatRecaps: createWebChatRecapRepository(deps.webchatRepo),
    chats,
    conversations: chats,
    ...(deps.guardianProfile
      ? {
          guardianProfile: createGuardianProfileRepository({
            db: deps.guardianProfile.db,
            settingsRepo: deps.settingsRepo,
            reactivateFloating: deps.guardianProfile.reactivateFloating,
          }),
        }
      : {}),
  };
}

function createGuardianProfileRepository(deps: {
  db: DrizzleDb;
  settingsRepo: SettingsRepository;
  reactivateFloating: () => Promise<void>;
}): GuardianProfileRepository {
  return {
    write: async (input) => {
      const result = await applyGuardianProfile(
        { guardianName: input.guardianName, agentName: input.agentName },
        deps,
      );
      return { ok: result.ok };
    },
  };
}

function createChatRepository(deps: CreateAppRuntimeRepositoriesDeps): ChatRepository {
  const repo = deps.webchatRepo;
  /** Channel `name` as an app's seat speaks through it: its send port. */
  const channelNamed = (name: string): Channel =>
    ({
      name,
      send: {
        send: (address: ChatId, message: OutgoingMessage) => deps.sendOn(name, address, message),
      },
    }) as unknown as Channel;
  const reads = deps.reads;
  const open: ChatRepository["ensureChannelChat"] = (input) =>
    openChannelChat(
      {
        chats: deps.chatRepo,
        webchatRepo: repo,
        adapters: deps.adapters,
      },
      input,
    );
  /**
   * Open a thread to `recipients` and say `out` there as main: its first
   * message, which starts it. Main's seat in the thread opens once the
   * provider took the message, so a refused email leaves no seat or line.
   */
  const startThread = async (
    channel: Channel,
    recipients: EmailRecipients,
    subject: string,
    out: EmailOutbound,
    recordedParts: readonly MessagePart[],
    turnId: string | undefined,
  ) => {
    const adapter = emailOf(deps.adapters, channel);
    const chat = adapter.open(recipients, subject);
    deps.chatRepo.start(chat, "group", subject || null);
    const romeEnd = adapter.account.id;
    let seat = "";
    const sent = await deps.chatMessages.send(
      {
        direction: "fromRome",
        place: placeIn(chat),
        saidBy: { account: { platform: chat.platform, id: romeEnd }, agent: "main" },
        parts: recordedParts,
      },
      async () => {
        const id = await adapter.send(chat.id, null, out);
        seat = (
          await open({
            channel: channel.name,
            threadId: deps.adapters.addressAt(channel.name, placeIn(chat)),
            agentName: "main",
            threadType: "group",
            ...(subject ? { threadName: subject } : {}),
          })
        ).id;
        return { id };
      },
    );
    if (sent.recorded && turnId) deps.links.answer(sent.id, seat, turnId);
    return {
      messageId: deps.seatLines.platformIdIn({ place: placeIn(chat), accountId: romeEnd }, sent.id),
      threadId: deps.adapters.addressAt(channel.name, placeIn(chat)),
    };
  };
  return {
    recentChats: ({ since, where }) => repo.recentChats(since, where),
    async transcript(sessionId, input = {}) {
      const transcript =
        (await reads.chatTranscript(sessionId)) ?? (await reads.sessionTranscript(sessionId));
      const since = input.since?.getTime() ?? 0;
      return transcript.lines
        .filter((line) => line.createdAt.getTime() >= since)
        .map((line) => ({
          id: line.id,
          turnId: line.turnId,
          role: line.role,
          senderId: line.senderAccountId,
          senderName: line.senderName,
          content: line.content,
          createdAt: line.createdAt,
        }));
    },
    traces: (sessionId) => repo.sessionTraces(sessionId),
    ensureChannelChat: open,
    ensureChannelConversation: open,
    // An app names the seat it opened. The message is recorded where the seat
    // stands, and a prompt is linked to the seat.
    addMessage: async (input) => {
      const seat = await repo.seatOf(input.sessionId);
      if (!seat) throw new Error(`No chat for session ${input.sessionId}`);
      const idOf = (platformMessageId: string) => deps.seatLines.idIn(seat, platformMessageId);
      const recorded = await deps.chatMessages.record({
        direction: "toRome",
        id: idOf(input.platformMessageId),
        place: seat.place,
        saidBy: {
          account: { platform: seat.place.chat.platform, id: input.senderId ?? "" },
          ...(input.senderName === undefined ? {} : { name: input.senderName }),
        },
        body: { text: messageContentText(input.content) ?? "" },
        ...(input.replyToPlatformMessageId === undefined
          ? {}
          : { replyTo: idOf(input.replyToPlatformMessageId) }),
        at: input.createdAt ?? new Date(),
      });
      if (!recorded) return { inserted: false };
      if (input.role === "user") deps.links.prompt(recorded.id, input.sessionId);
      await repo.advanceActivity(input.sessionId, recorded.at);
      return { inserted: true };
    },
    promoteMessageToUser: async (sessionId, platformMessageId) => {
      const line = await deps.seatLines.recorded(sessionId, platformMessageId);
      if (line) deps.links.prompt(line.id, sessionId);
    },
    // An app names the seat it opened. Its message is said there as the
    // seat's, and is the turn's answer when the turn knows it.
    // An app's seat speaks through its account's chat adapter, which sends
    // on the channel and names the line Chats records.
    async send(input) {
      const channel = channelNamed(input.channel);
      const parts = input.parts?.length ? stripHostOnly(input.parts) : undefined;
      // An app quotes by the platform's id, which names a line of its seat's chat.
      const seat = input.replyToPlatformMessageId ? await repo.seatOf(input.sessionId) : null;
      const sent = await deps.replies.send(
        input.sessionId,
        channel,
        {
          text: input.text ?? "",
          ...(parts ? { parts } : {}),
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          ...(seat && input.replyToPlatformMessageId
            ? { replyTo: deps.seatLines.idIn(seat, input.replyToPlatformMessageId) }
            : {}),
        },
        {
          ...(input.knownToProvider && input.turnId ? { turnId: input.turnId } : {}),
          ...(input.content
            ? {
                recorded: JSON.parse(stripHostOnlyPartsFromContent(input.content)) as MessagePart[],
              }
            : {}),
        },
      );
      if (!sent) throw new Error(`Session ${input.sessionId} stands in no chat`);
      const messageId = deps.seatLines.platformIdIn(sent.seat, sent.sent);
      return messageId ? { messageId } : {};
    },
    async sendEmail(input) {
      const channel = channelNamed(input.channel);
      const parts = input.parts?.length ? stripHostOnly(input.parts) : undefined;
      const recorded = input.content
        ? (JSON.parse(stripHostOnlyPartsFromContent(input.content)) as MessagePart[])
        : undefined;
      const { to, cc, bcc, subject, html, inReplyToMessageId } = input.email;
      if (inReplyToMessageId !== undefined && !inReplyToMessageId.trim()) {
        throw new Error("Email replyToMessageId must not be blank. No email was sent.");
      }
      // An email's body is its text, else the text of its parts.
      const text = input.text ?? (parts ? partsText(parts) : "");
      const out: EmailOutbound = { text, ...(parts ? { parts } : {}), ...(html ? { html } : {}) };
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
      // An email thread is a group chat, main's unless the caller names its seat.
      const sessionId =
        input.sessionId ??
        (
          await open({
            channel: input.channel,
            threadId: input.threadId!,
            agentName: "main",
            threadType: "group",
          })
        ).id;
      const seat = inReplyToMessageId ? await repo.seatOf(sessionId) : null;
      const sent = await deps.replies.send(
        sessionId,
        channel,
        {
          ...out,
          ...(seat && inReplyToMessageId
            ? { replyTo: deps.seatLines.idIn(seat, inReplyToMessageId) }
            : {}),
        },
        { ...(turnId ? { turnId } : {}), ...(recorded ? { recorded } : {}) },
      );
      if (!sent) throw new Error(`Session ${sessionId} stands in no chat`);
      return {
        messageId: deps.seatLines.platformIdIn(sent.seat, sent.sent),
        threadId: deps.adapters.addressAt(input.channel, sent.seat.place),
      };
    },
  };
}

/** `parts` with the parts only the host may author taken out, so a forged
 *  routine card never reaches the chat. */
function stripHostOnly(parts: MessagePart[]): MessagePart[] {
  return JSON.parse(stripHostOnlyPartsFromContent(JSON.stringify(parts))) as MessagePart[];
}

function createAppSettingsRepository(repo: SettingsRepository): AppSettingsRepository {
  return {
    get: (key) => repo.get(key),
    set: (key, value) => repo.set(key, value),
  };
}

function createWebChatRecapRepository(repo: WebChatRepository): WebChatRecapRepository {
  return {
    getSession: (id) => repo.getSession(id),
    getMessages: (sessionId) => repo.getMessages(sessionId),
    addTurnRecapMessage: (input) => repo.addTurnRecapMessage(input),
  };
}
