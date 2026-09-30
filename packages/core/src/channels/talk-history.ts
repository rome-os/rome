// `ChannelsService.history` — the read `fetch_channel_history` makes, in the
// main process or over RPC from an action worker — answered from the
// channel's `messages`.
//
// Each channel's Connection used to answer it with a history read of its own,
// and those reads cut the window and the page each their own way. The reads
// over a store (WhatsApp, LinkedIn, WeChat) are retired now that the store
// answers `query`, but the tool's output is meant to read exactly as it did, so
// this reproduces what each of them answered: the window, which messages of it
// were kept, and in what order. Stores answer `query` newest first, and this
// answers oldest first, as the retired reads did.

import type { ChannelMessage, ConversationId, TalkHistory } from "@rome-os/app-runtime";
import type { Channel } from "./channel.js";
import { MAX_QUERY_LIMIT } from "./messages.js";
import { WECHAT_USER_CHANNEL } from "./wechat-user-messages.js";
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
 * How a store's retired history read cut what it answered.
 *
 * - `hours`: the mirror reads (WhatsApp, LinkedIn) widened `since` to whole
 *   hours before now, read the mirror's newest thousand in that window to the
 *   second, and kept the oldest `limit` of them.
 * - `newest`: the WeChat reader read from `since` to the second and kept the
 *   newest `limit`.
 */
const RETIRED_READS: Record<string, "hours" | "newest"> = {
  whatsapp: "hours",
  linkedin: "hours",
  [WECHAT_USER_CHANNEL]: "newest",
};

/** Where a history read goes for one connection. */
export interface TalkHistorySource {
  /** The channel of the connection's service, if the service has one. */
  channel: Channel | undefined;
  /** The connection's own history read, for a channel with no store. */
  connectionHistory: TalkHistory | null;
}

/**
 * What a history read answers for one connection, oldest first.
 *
 * A channel with a store answers from it, cut the way its retired read cut.
 * A channel with no store answers from the named connection's own history,
 * the read its `messages` is built on, with the input as given: that read
 * is the one the tool always made, so its window and page are unchanged, and
 * a service with several connections answers for the one asked about.
 */
export async function readTalkHistory(
  source: TalkHistorySource,
  connectionId: string,
  input: TalkHistoryInput,
): Promise<ChannelMessage[]> {
  const unavailable = () =>
    new Error(`Talk history is unavailable for connection "${connectionId}"`);
  const retired = source.channel ? RETIRED_READS[source.channel.name] : undefined;
  if (!retired) {
    if (!source.connectionHistory) throw unavailable();
    return source.connectionHistory.query(input);
  }
  const messages = source.channel?.messages;
  if (!messages) throw unavailable();
  const conversation = input.conversationId ? { conversationId: input.conversationId } : {};
  const keep = historyQueryLimit(input.limit);

  if (retired === "newest") {
    const page = await messages.query({
      ...conversation,
      ...(input.since ? { since: toSecond(input.since) } : {}),
      limit: keep,
    });
    return page.reverse();
  }
  const since = new Date(Date.now() - historyWindowHours(input.since) * 3_600_000);
  const page = await messages.query({
    ...conversation,
    since: toSecond(since),
    limit: MAX_QUERY_LIMIT,
  });
  return page.reverse().slice(0, keep);
}

/** The whole second `at` falls in. The retired reads compared seconds, so a
 *  window opening inside a second took all of it. */
function toSecond(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 1000) * 1000);
}
