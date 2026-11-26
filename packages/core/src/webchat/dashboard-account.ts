// The dashboard chat as a channel. It is Rome's own chat behind the guardian's
// sign-in, not a connection: no access to an external account was given, so
// no Connection backs it (docs/domains/connections.md#connection). Rome serves
// its ports itself, in-process. Channel contract: channel.ts.

import { AsyncLocalStorage } from "node:async_hooks";
import { platformOf } from "@rome/api-types/platform";
import { actionExecutionContext } from "../apps/actions/context.js";
import { canOpen, privateOwnerOf } from "./privacy.js";
import { type SessionActor, sessionOwnerKey } from "../access/session-actor.js";
import type { ChannelSurface } from "../core/session-opening.js";
import type { WebChatRepository } from "./repository.js";
import type { Channel } from "../chats/connected-accounts/connected-account.js";
import { queryPage } from "../chats/history/messages.js";
import { readWebchatMessages, WebChatAdapter } from "./adapter.js";

export const WEBCHAT_CHANNEL = "webchat";

/** The dashboard's platform: Rome's own chat behind the guardian's sign-in. */
export const DASHBOARD_PLATFORM = platformOf(WEBCHAT_CHANNEL);

/** How the dashboard chat prompts: it renders cards inline and answers them
 *  as the next turn, and every line in it is a guardian turn or the agent's
 *  own reply, so prompts carry no unseen messages. */
export const WEBCHAT_SURFACE: ChannelSurface = { interactiveCards: true, promptContext: false };

/** Who reads dashboard chats from an action: the person accountable for the turn, and the chat it runs in. */
export interface DashboardCaller {
  actor?: SessionActor;
  chatId: string | null;
}

/**
 * The caller of a read made through the worker boundary by an
 * app's action. An action run in this process carries it in its own context
 * instead.
 */
export const webchatCaller = new AsyncLocalStorage<DashboardCaller>();

/** The caller an action stands for: its person, and its chat when that chat is a dashboard chat. */
export function dashboardCallerOf(
  action:
    | { actor?: SessionActor; channelContext?: { channel: string; threadId?: string } }
    | undefined,
): DashboardCaller {
  const context = action?.channelContext;
  return {
    actor: action?.actor,
    chatId: context?.channel === WEBCHAT_CHANNEL && context.threadId ? context.threadId : null,
  };
}

function dashboardCaller(): DashboardCaller {
  return webchatCaller.getStore() ?? dashboardCallerOf(actionExecutionContext.getStore());
}

/**
 * Whose Concierge and task chats a history read of no one chat shows. A
 * person's turn reads as that person, whoever owns the chat it runs in. A turn
 * no person sent (a routine, a system turn) reads as the owner of the Concierge
 * or task chat it runs in, and as nobody elsewhere.
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
        if (!(await webchatRepo.getSession(chatId))) throw new Error(`No dashboard chat ${chatId}`);
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
        // A read of every chat leaves out other people's Concierge and task
        // chats, as the chat list does. A read of one chat reads it.
        const owner = await readerOwner(webchatRepo, dashboardCaller());
        const hidden = new Set<string>();
        for (const id of chatId ? [] : new Set(lines.map((message) => message.chatId))) {
          if (!canOpen(await webchatRepo.getSession(id), owner)) hidden.add(id);
        }
        const newestFirst = lines
          .filter((message) => !hidden.has(message.chatId))
          .filter((message) => message.timestamp.getTime() >= from.getTime())
          .reverse()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return queryPage(newestFirst, { after, limit });
      },
      byAccount: null,
    },
  };
}
