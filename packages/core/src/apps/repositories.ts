import type {
  AppRuntimeRepositories,
  AppSettingsRepository,
  ChatRepository,
  GuardianProfileRepository,
  MessagePart,
  WebChatRecapRepository,
} from "@rome-os/app-runtime";
import type { ChatRepository as ChatsByKey } from "../chats/chat-repository.js";
import { stripHostOnlyPartsFromContent } from "../channels/host-only-parts.js";
import { messageContentText } from "../channels/messages-agent.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { openChannelChat, type OpenChannelChatDeps } from "../chats/open-chat.js";
import { ownedBy } from "../chats/place.js";
import type { SeatReplies } from "../sessions/seat-replies.js";
import type { TurnLinks } from "../sessions/turn-links.js";
import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { applyGuardianProfile } from "../lib/guardian-profile.js";

export interface CreateAppRuntimeRepositoriesDeps {
  settingsRepo: SettingsRepository;
  webchatRepo: WebChatRepository;
  /** The chats a channel thread's first message starts. */
  chatRepo: Pick<ChatsByKey, "start">;
  /** Where a message an app hands over is put on record. */
  chatMessages: Pick<MessageRepository, "record">;
  /** What an app's seat says, recorded and linked to its turn. */
  replies: Pick<SeatReplies, "say">;
  links: Pick<TurnLinks, "prompt">;
  accountOf: OpenChannelChatDeps["accountOf"];
  platformOfChannel: OpenChannelChatDeps["platformOfChannel"];
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
  const open: ChatRepository["ensureChannelChat"] = (input) =>
    openChannelChat(
      {
        chats: deps.chatRepo,
        webchatRepo: repo,
        accountOf: deps.accountOf,
        platformOfChannel: deps.platformOfChannel,
      },
      input,
    );
  return {
    ensureChannelChat: open,
    ensureChannelConversation: open,
    // An app names the seat it opened. The message is recorded where the seat
    // stands, and a prompt is linked to the seat.
    addMessage: async (input) => {
      const seat = await repo.seatOf(input.sessionId);
      if (!seat) throw new Error(`No chat for session ${input.sessionId}`);
      const recorded = await deps.chatMessages.record({
        direction: "toRome",
        place: seat.place,
        saidBy: {
          account: { platform: seat.place.chat.platform, id: input.senderId ?? "" },
          ...(input.senderName === undefined ? {} : { name: input.senderName }),
        },
        body: { text: messageContentText(input.content) ?? "" },
        platformMessageId: ownedBy(seat.place.chat, seat.accountId, input.platformMessageId),
        ...(input.replyToPlatformMessageId === undefined
          ? {}
          : {
              replyTo: ownedBy(seat.place.chat, seat.accountId, input.replyToPlatformMessageId),
            }),
        at: input.createdAt ?? new Date(),
      });
      if (!recorded) return { inserted: false };
      if (input.role === "user") deps.links.prompt(recorded.id, input.sessionId);
      await repo.advanceActivity(input.sessionId, recorded.at);
      return { inserted: true };
    },
    promoteMessageToUser: async (sessionId, platformMessageId) => {
      const id = await repo.seatMessageId(sessionId, platformMessageId);
      if (id) deps.links.prompt(id, sessionId);
    },
    // An app names the seat it opened. Its message is said there as the
    // seat's, and is the turn's answer when the turn knows it.
    recordOutboundMessage: async (input) => {
      await deps.replies.say(
        input.sessionId,
        // Only the host may author routine cards, so a forged one never
        // reaches the chat.
        JSON.parse(stripHostOnlyPartsFromContent(input.content)) as MessagePart[],
        async () => (input.platformMessageId ? { platformMessageId: input.platformMessageId } : {}),
        {
          ...(input.knownToProvider && input.turnId ? { turnId: input.turnId } : {}),
          ...(input.replyToPlatformMessageId ? { replyTo: input.replyToPlatformMessageId } : {}),
        },
      );
    },
  };
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
