// The dashboard chat as a channel. It is Rome's own chat behind the guardian's
// sign-in, not a connection: no access to an external account was given, so
// no Connection backs it (docs/domains/connections.md#connection). Rome serves
// its ports itself, in-process. Channel contract: channel.ts.

import type { ChannelSurface } from "../core/agent-session.js";
import type { WebChatRepository } from "../db/repositories/webchat.js";
import { historyWindowHours } from "../connections/integrations/talk-features.js";
import type { Channel } from "./channel.js";
import { queryLimit } from "./messages.js";
import { WebChatAdapter } from "./webchat.js";

export const WEBCHAT_CHANNEL = "webchat";

/** How the dashboard chat prompts: it renders cards inline and answers them
 *  as the next turn, and every line in it is a guardian turn or the agent's
 *  own reply, so prompts carry no unseen messages. */
export const WEBCHAT_SURFACE: ChannelSurface = { interactiveCards: true, promptContext: false };

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
      replies: null,
      direct: null,
      activity: null,
    },
    inbound: null,
    accounts: null,
    directory: null,
    messages: {
      async query({ chatId, since, before, limit }) {
        const from = since ?? new Date(Date.now() - DEFAULT_WINDOW_MS);
        const lines = await adapter.fetchHistory(chatId ?? null, historyWindowHours(from));
        // Reversed before the sort, so lines sharing a timestamp come newest
        // first too.
        return lines
          .filter((message) => message.timestamp.getTime() >= from.getTime())
          .filter((message) => !before || message.timestamp.getTime() < before.getTime())
          .reverse()
          .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
          .slice(0, queryLimit(limit));
      },
      byAccount: null,
    },
  };
}
