// The dashboard chat as a channel. It is Rome's own chat behind the guardian's
// sign-in, not a connection: no access to an external account was given, so
// no Connection backs it (docs/domains/connections.md#connection). Rome serves
// its ports itself, in-process. Channel contract: channel.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import { actionExecutionContext } from "../../actions/context.js";
import { canOpenChat } from "../../concierge/privacy.js";
import type { ChannelSurface } from "../../core/agent-session.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { Channel } from "../connected-accounts/connected-account.js";
import { queryPage } from "../history/messages.js";
import { readWebchatMessages, WebChatAdapter } from "./webchat.js";

export const WEBCHAT_CHANNEL = "webchat";

/** How the dashboard chat prompts: it renders cards inline and answers them
 *  as the next turn, and every line in it is a guardian turn or the agent's
 *  own reply, so prompts carry no unseen messages. */
export const WEBCHAT_SURFACE: ChannelSurface = { interactiveCards: true, promptContext: false };

/**
 * The dashboard chat a history read is made from, when an app's action reads
 * through the worker boundary. An action run in this process carries it in
 * its own context instead.
 */
export const webchatHistoryReader = new AsyncLocalStorage<{ chatId: string | null }>();

/** The chat whose turn reads history, or null for a read no chat's turn made. */
function readingChat(): string | null {
  const given = webchatHistoryReader.getStore();
  if (given) return given.chatId;
  const context = actionExecutionContext.getStore()?.channelContext;
  return context?.channel === WEBCHAT_CHANNEL && context.threadId ? context.threadId : null;
}

/** A query naming no `since` reads the last day, as a live read does. */
const DEFAULT_WINDOW_MS = 24 * 3_600_000;

/**
 * The webchat channel. It sends by storing the reply in its chat, and reads
 * what was said from the same store. Nothing arrives on it through a port:
 * a guardian turn starts from webchat's own HTTP routes. It has no address
 * book and no conversation directory.
 */
export function webchatChannel(webchatRepo: WebChatRepository): Channel {
  const adapter = new WebChatAdapter(webchatRepo);
  return {
    name: WEBCHAT_CHANNEL,
    send: {
      send: (chatId, message) => adapter.send(chatId, message),
      direct: null,
      activity: null,
    },
    inbound: null,
    accounts: null,
    directory: null,
    messages: {
      async query({ chatId, since, after, limit }) {
        const from = since ?? new Date(Date.now() - DEFAULT_WINDOW_MS);
        const lines = await readWebchatMessages(webchatRepo, chatId ?? null, from);
        // Reversed before the sort, so lines sharing a timestamp come newest
        // first too.
        // A Concierge chat and its task chats are their owner's alone, so a
        // read made from someone else's chat leaves them out. A read no chat's
        // turn made is in-process work, and reads as the guardian.
        const reader = readingChat();
        const readerChat = reader ? await webchatRepo.getSession(reader) : null;
        const owner = readerChat?.ownerKey || "guardian";
        const allowed = new Map<string, boolean>();
        for (const id of new Set(lines.map((message) => message.chatId))) {
          allowed.set(id, await canOpenChat((chatId) => webchatRepo.getSession(chatId), id, owner));
        }
        const newestFirst = lines
          .filter((message) => allowed.get(message.chatId) === true)
          .filter((message) => message.timestamp.getTime() >= from.getTime())
          .reverse()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return queryPage(newestFirst, { after, limit });
      },
      byAccount: null,
    },
  };
}
