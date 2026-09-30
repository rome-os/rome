// `talk.history.query` — the read `fetch_channel_history` makes from an action
// worker — answered from the channel's `messages`.
//
// Each channel's Connection used to answer it with a history read of its own,
// and those reads cut the window and the page each their own way. They are
// retired now that the channel answers `query` for every data holder, but the
// tool's output is meant to read exactly as it did, so this reproduces what
// each one answered: the window it read, which messages of it it kept, and in
// what order. Channels answer `query` newest first, and this answers oldest
// first, as the retired reads did.

import type { ChannelMessage, ConversationId } from "@rome-os/app-runtime";
import type { Channel } from "../channels/channel.js";
import { MAX_QUERY_LIMIT } from "../channels/messages.js";
import {
  historyQueryLimit,
  historyWindowHours,
} from "../connections/integrations/talk-features.js";

export interface TalkHistoryInput {
  conversationId?: ConversationId;
  since?: Date;
  limit?: number;
}

/**
 * How a channel's retired history read cut what it answered.
 *
 * - `hours`: the mirror reads (WhatsApp, LinkedIn) widened `since` to whole
 *   hours before now, read the mirror's newest thousand in that window to the
 *   second, and kept the oldest `limit` of them.
 * - `newest`: the WeChat reader read from `since` to the second and kept the
 *   newest `limit`.
 * - A channel read live through its Connection answers `query` from that same
 *   history, window and all, so it keeps the oldest `limit` of what it answers.
 */
const RETIRED_READS: Record<string, "hours" | "newest"> = {
  whatsapp: "hours",
  linkedin: "hours",
  wechat_user: "newest",
};

/** What `talk.history.query` answers for `channel`, oldest first. */
export async function readTalkHistory(
  channel: Channel | undefined,
  connectionId: string,
  input: TalkHistoryInput,
): Promise<ChannelMessage[]> {
  const messages = channel?.messages;
  if (!channel || !messages) {
    throw new Error(`Talk history is unavailable for connection "${connectionId}"`);
  }
  const conversation = input.conversationId ? { conversationId: input.conversationId } : {};
  const keep = historyQueryLimit(input.limit);

  switch (RETIRED_READS[channel.name]) {
    case "newest": {
      const page = await messages.query({
        ...conversation,
        ...(input.since ? { since: toSecond(input.since) } : {}),
        limit: keep,
      });
      return page.reverse();
    }
    case "hours": {
      const since = new Date(Date.now() - historyWindowHours(input.since) * 3_600_000);
      const page = await messages.query({
        ...conversation,
        since: toSecond(since),
        limit: MAX_QUERY_LIMIT,
      });
      return page.reverse().slice(0, keep);
    }
    default: {
      const page = await messages.query({
        ...conversation,
        ...(input.since ? { since: input.since } : {}),
        limit: MAX_QUERY_LIMIT,
      });
      return page.reverse().slice(0, keep);
    }
  }
}

/** The whole second `at` falls in. The retired reads compared seconds, so a
 *  window opening inside a second took all of it. */
function toSecond(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}
