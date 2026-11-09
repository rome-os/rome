// The dashboard chat as a channel. It is Rome's own chat behind the guardian's
// sign-in, not a connection: no access to an external account was given, so
// no Connection backs it (docs/domains/connections.md#connection). Rome serves
// its ports itself, in-process. Channel contract: channel.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import { actionExecutionContext } from "../../apps/actions/context.js";
import { canOpenChat, privateOwnerOf } from "../../concierge/privacy.js";
import { type SessionActor, sessionOwnerKey } from "../../lib/session-actor.js";
import type { ChannelSurface } from "../../core/session-opening.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { Channel } from "../connected-accounts/connected-account.js";
import { queryPage } from "../history/messages.js";
import { readWebchatMessages, WebChatAdapter } from "./webchat.js";

export const WEBCHAT_CHANNEL = "webchat";

/** How the dashboard chat prompts: it renders cards inline and answers them
 *  as the next turn, and every line in it is a guardian turn or the agent's
 *  own reply, so prompts carry no unseen messages. */
export const WEBCHAT_SURFACE: ChannelSurface = { interactiveCards: true, promptContext: false };

/** Who reads or writes dashboard chats from an action: the person accountable for the turn, and the chat it runs in. */
export interface DashboardCaller {
  actor?: SessionActor;
  chatId: string | null;
}

/**
 * The caller of a read or a send made through the worker boundary by an
 * app's action. An action run in this process carries it in its own context
 * instead.
 */
export const webchatCaller = new AsyncLocalStorage<DashboardCaller>();

function dashboardCaller(): DashboardCaller {
  const given = webchatCaller.getStore();
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
export async function readerOwner(
  webchatRepo: WebChatRepository,
  reader: DashboardCaller,
): Promise<string | null> {
  const person = reader.actor && reader.actor.kind !== "anonymous" ? reader.actor : undefined;
  if (person) return sessionOwnerKey(person);
  if (!reader.chatId) return null;
  return privateOwnerOf(await webchatRepo.getSession(reader.chatId));
}

/**
 * An action may write only into a chat its caller may open, as the dashboard's
 * own routes allow: another person's Concierge or task chat is not found. A
 * send no person's or chat's turn made is Rome's own work, and goes through.
 */
async function refuseAnotherOwnersChat(webchatRepo: WebChatRepository, chatId: string) {
  const caller = dashboardCaller();
  const person = caller.actor && caller.actor.kind !== "anonymous";
  if (!person && !caller.chatId) return;
  const owner = await readerOwner(webchatRepo, caller);
  if (!(await canOpenChat((id) => webchatRepo.getSession(id), chatId, owner))) {
    throw new Error(`No dashboard chat ${chatId}`);
  }
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
      send: async (chatId, message) => {
        await refuseAnotherOwnersChat(webchatRepo, chatId);
        return adapter.send(chatId, message);
      },
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
        const owner = await readerOwner(webchatRepo, dashboardCaller());
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
