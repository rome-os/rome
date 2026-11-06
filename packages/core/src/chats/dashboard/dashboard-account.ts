// The dashboard chat as a channel. It is Rome's own chat behind the guardian's
// sign-in, not a connection: no access to an external account was given, so
// no Connection backs it (docs/domains/connections.md#connection). Rome serves
// its ports itself, in-process. Channel contract: channel.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import { actionExecutionContext } from "../../actions/context.js";
import { chatAccess, chatAccessOver } from "../../concierge/privacy.js";
import { type SessionActor, sessionOwnerKey } from "../../lib/session-actor.js";
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

/** Who reads dashboard history: the person accountable for the turn, and the chat it runs in. */
interface HistoryReader {
  actor?: SessionActor;
  chatId: string | null;
}

/**
 * The reader of a history read made through the worker boundary by an app's
 * action. An action run in this process carries it in its own context instead.
 */
export const webchatHistoryReader = new AsyncLocalStorage<HistoryReader>();

function historyReader(): HistoryReader {
  const given = webchatHistoryReader.getStore();
  if (given) return given;
  const store = actionExecutionContext.getStore();
  const context = store?.channelContext;
  return {
    actor: store?.actor,
    chatId: context?.channel === WEBCHAT_CHANNEL && context.threadId ? context.threadId : null,
  };
}

/**
 * Whose chats a history read may show. A person's turn reads as that person,
 * whoever owns the chat it runs in, since ordinary chats are open to every
 * dashboard user. A turn no person sent (a routine, a system turn) reads as
 * the owner of the Concierge or task chat it runs in, and as nobody elsewhere,
 * so it sees no one's Concierge or task chats.
 */
async function readerOwner(
  webchatRepo: WebChatRepository,
  reader: HistoryReader,
): Promise<string | null> {
  const person = reader.actor && reader.actor.kind !== "anonymous" ? reader.actor : undefined;
  if (person) return sessionOwnerKey(person);
  if (!reader.chatId) return null;
  return chatAccess((id) => webchatRepo.getSession(id), null).privateOwner(reader.chatId);
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
        // A Concierge chat and its task chats are their owner's alone, by the
        // same policy the chat routes use.
        const access = chatAccessOver(
          await webchatRepo.listChatLineage(),
          await readerOwner(webchatRepo, historyReader()),
        );
        const allowed = new Map<string, boolean>();
        for (const id of new Set(lines.map((message) => message.chatId))) {
          allowed.set(id, await access.canOpen(id));
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
