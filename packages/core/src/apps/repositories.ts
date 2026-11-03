import type {
  AppRuntimeRepositories,
  AppSettingsRepository,
  ChatRepository,
  GuardianProfileRepository,
  MessagePart,
  WebChatRecapRepository,
} from "@rome-os/app-runtime";
import type { ChatRepository as ChatsByKey } from "../chats/chat-repository.js";
import type { MessageRepository } from "../chats/message-repository.js";
import { openChannelChat } from "../chats/open-chat.js";
import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { applyGuardianProfile } from "../lib/guardian-profile.js";

export interface CreateAppRuntimeRepositoriesDeps {
  settingsRepo: SettingsRepository;
  webchatRepo: WebChatRepository;
  /** The chats a channel thread's first message starts. */
  chatRepo: ChatsByKey;
  /** Where a message an app sent is put on record. */
  chatMessages: Pick<MessageRepository, "recordSent">;
  /** Present in the main process only, where the profile write can reschedule
   *  floating routines. An action worker gets no guardianProfile repository. */
  guardianProfile?: { db: DrizzleDb; reactivateFloating: () => Promise<void> };
}

export function createAppRuntimeRepositories(
  deps: CreateAppRuntimeRepositoriesDeps,
): AppRuntimeRepositories {
  const chats = createChatRepository(deps.webchatRepo, deps.chatRepo, deps.chatMessages);
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

function createChatRepository(
  repo: WebChatRepository,
  chats: ChatsByKey,
  messages: Pick<MessageRepository, "recordSent">,
): ChatRepository {
  const open: ChatRepository["ensureChannelChat"] = (input) =>
    openChannelChat({ chats, webchatRepo: repo }, input);
  return {
    ensureChannelChat: open,
    ensureChannelConversation: open,
    addMessage: (input) => repo.addConversationMessage(input),
    promoteMessageToUser: (sessionId, platformMessageId) =>
      repo.promoteConversationMessageToUser(sessionId, platformMessageId),
    // An app names the conversation row it opened. The message is recorded in
    // the place that row stands for, as said by Rome.
    recordOutboundMessage: async (input) => {
      const at = chats.placeOfRecord(input.sessionId);
      if (!at) throw new Error(`No place for conversation ${input.sessionId}`);
      await messages.recordSent(
        {
          direction: "fromRome",
          place: at.place,
          parts: JSON.parse(input.content) as MessagePart[],
          ...(input.platformMessageId ? { platformMessageId: input.platformMessageId } : {}),
          ...(input.replyToPlatformMessageId ? { replyTo: input.replyToPlatformMessageId } : {}),
          ...(input.turnId ? { turnId: input.turnId } : {}),
          turnAnswer: input.knownToProvider,
        },
        { channel: at.channel },
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
