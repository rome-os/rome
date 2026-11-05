import type { ConnectionKindOfChannel } from "../db/repositories/channel-records.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { chatRoutineKeyForToolUse } from "../routines/chat-routine-key.js";
import type { SessionCallerPorts } from "./agent-session.js";
import { chatModelSelection } from "./chat-model-selection.js";
import { isGuardianFacingChannel } from "./guardian-channel.js";
import { callerKey } from "./session-caller.js";
import { findRecordedConversation } from "./session-conversation.js";

/**
 * What the session asks its callers, answered from the dashboard's chats and
 * the connections: the conversation a row recorded, the model a chat chose,
 * whether a wake-up can come back, and the key a chat's routine card finds
 * its routine by.
 */
export function sessionCallers(deps: {
  webchatRepo?: Pick<WebChatRepository, "getSession">;
  connectionKindOfChannel?: ConnectionKindOfChannel;
}): SessionCallerPorts {
  return {
    findConversation: (chatId) =>
      findRecordedConversation(deps.webchatRepo as WebChatRepository | undefined, chatId),
    rememberedSelection: chatModelSelection(deps.webchatRepo),
    canWake: (caller) => isGuardianFacingChannel(callerKey(caller), deps.connectionKindOfChannel),
    routineKeyFor: chatRoutineKeyForToolUse,
  };
}
