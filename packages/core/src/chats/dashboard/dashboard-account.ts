// The dashboard chat as a channel. It is Rome's own chat behind the guardian's
// sign-in, not a connection: no access to an external account was given, so
// no Connection backs it (docs/domains/connections.md#connection). Rome serves
// its ports itself, in-process. Channel contract: channel.ts.

import type { ChannelSurface } from "../../core/agent-session.js";
import type { WebChatRepository } from "../../db/repositories/webchat.js";
import type { ConnectionKind } from "../../connections/connection-kind.js";
import type { Channel } from "../connected-accounts/connected-account.js";
import { queryPage } from "../history/messages.js";
import { readWebchatMessages, WebChatAdapter } from "./webchat.js";

export const WEBCHAT_CHANNEL = "webchat";

/** How the dashboard chat prompts: it renders cards inline and answers them
 *  as the next turn, and every line in it is a guardian turn or the agent's
 *  own reply, so prompts carry no unseen messages. */
export const WEBCHAT_SURFACE: ChannelSurface = { interactiveCards: true, promptContext: false };

/** A query naming no `since` reads the last day, as a live read does. */
const DEFAULT_WINDOW_MS = 24 * 3_600_000;

/**
 * The webchat channel. It sends by storing the reply in its chat. Nothing
 * arrives on it through a port: a guardian turn starts from webchat's own
 * HTTP routes. It has no conversation directory, and what was said in it is
 * read through {@link webchatKind}.
 */
export function webchatChannel(webchatRepo: WebChatRepository): Channel {
  const adapter = new WebChatAdapter(webchatRepo);
  return {
    name: WEBCHAT_CHANNEL,
    send: {
      send: (chatId, message) => adapter.send(chatId, message),
      replies: null,
      direct: null,
      activity: null,
    },
    inbound: null,
    directory: null,
  };
}

/** The dashboard chat's reads: what was said in it, from the store its
 *  replies are written to. It has no address book. */
export function webchatKind(webchatRepo: WebChatRepository): ConnectionKind {
  return {
    name: WEBCHAT_CHANNEL,
    accounts: null,
    messages: {
      async query({ chatId, since, after, limit }) {
        const from = since ?? new Date(Date.now() - DEFAULT_WINDOW_MS);
        const lines = await readWebchatMessages(webchatRepo, chatId ?? null, from);
        // Reversed before the sort, so lines sharing a timestamp come newest
        // first too.
        const newestFirst = lines
          .filter((message) => message.timestamp.getTime() >= from.getTime())
          .reverse()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
        return queryPage(newestFirst, { after, limit });
      },
      byAccount: null,
    },
  };
}
