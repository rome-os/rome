import type {
  AppRuntimeRepositories,
  AppSettingsRepository,
  ChatRepository,
  GuardianProfileRepository,
  WebChatRecapRepository,
} from "@rome-os/app-runtime";
import { openChannelChat, type OpenSpeakerDeps } from "../connections/open-chat.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { WebChatRepository } from "../webchat/repository.js";
import { type AppChatReadsDeps, appChatReads } from "./chat-reads.js";
import { type AppChatWritesDeps, appChatWrites } from "./chat-writes.js";

export interface CreateAppRuntimeRepositoriesDeps {
  settingsRepo: SettingsRepository;
  webchatRepo: WebChatRepository;
  /** Chats and Agents' speakers: a channel thread's chat starts in Chats,
   *  and its session stands in it as the channel account's speaker. */
  speakers: OpenSpeakerDeps;
  /** Chats, read and written for apps. Given, an app reads its chats
   *  through `recentChats`, `transcript` and `traces`, and its lines go on
   *  record in Chats: `addMessage`, `promoteMessageToUser`, `send` and
   *  `sendEmail`. Its `open` opens every channel session, so it has to put
   *  the session in Chats. The Chats switch passes it. */
  inChats?: { reads: AppChatReadsDeps; writes: AppChatWritesDeps };
  /** Present in the main process only, where the profile write can reschedule
   *  floating routines. An action worker gets no guardianProfile repository. */
  guardianProfile?: GuardianProfileRepository;
}

export function createAppRuntimeRepositories(
  deps: CreateAppRuntimeRepositoriesDeps,
): AppRuntimeRepositories {
  const legacy = createChatRepository(deps.webchatRepo, deps.speakers);
  const chats: ChatRepository = deps.inChats
    ? {
        ...legacy,
        ...appChatReads(deps.inChats.reads),
        ...appChatWrites(deps.inChats.writes),
        // A session opens in Chats too, where the writes find it.
        ensureChannelChat: deps.inChats.writes.open,
        ensureChannelConversation: deps.inChats.writes.open,
      }
    : legacy;
  return {
    settings: createAppSettingsRepository(deps.settingsRepo),
    webchatRecaps: createWebChatRecapRepository(deps.webchatRepo),
    chats,
    conversations: chats,
    ...(deps.guardianProfile ? { guardianProfile: deps.guardianProfile } : {}),
  };
}

function createChatRepository(repo: WebChatRepository, speakers: OpenSpeakerDeps): ChatRepository {
  const open: ChatRepository["ensureChannelChat"] = (input) =>
    openChannelChat({ records: repo, speakers }, input);
  return {
    ensureChannelChat: open,
    ensureChannelConversation: open,
    addMessage: (input) => repo.addConversationMessage(input),
    promoteMessageToUser: (sessionId, platformMessageId) =>
      repo.promoteConversationMessageToUser(sessionId, platformMessageId),
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
