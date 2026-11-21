// A chat's history as the Slack app connection reads it: from Slack's
// conversations.history, live. Contract: `TalkHistory` (connections/types.ts).
// The connection keeps no record of its own, so every read asks Slack.
//
// Slack lets an app read one page of a conversation a minute, of up to 15
// messages, so a read asks Slack once. It answers what it has, which may be
// fewer than its limit: a reader reads on from the oldest message.

import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { TalkHistoryRead } from "../../types.js";
import { compareTs, tsAt } from "./timeline-order.js";

/** One page of a chat's history as Slack answered it, newest first. */
export interface SlackHistoryPage {
  messages: Array<{ ts: string; message: ChannelMessage }>;
  /** Whether Slack holds older messages than the page within its bounds. */
  hasMore: boolean;
  /** The oldest message Slack answered, read or not: a page of only joins
   *  or edits holds none Rome reads, while Slack holds older messages below
   *  it. */
  oldest?: string;
}

/** One request for a page: only messages before `latest` (exclusive). */
export type FetchHistoryPage = (
  channelId: string,
  bounds: { latest?: string },
) => Promise<SlackHistoryPage>;

/** One microsecond later, so an inclusive bound reads as an exclusive one. */
function justAfter(ts: string): string {
  const [seconds, micros = "0"] = ts.split(".");
  const next = Number(micros.padEnd(6, "0")) + 1;
  return next >= 1_000_000
    ? `${Number(seconds) + 1}.000000`
    : `${seconds}.${String(next).padStart(6, "0")}`;
}

/** The messages of `chatId` within `read`'s bounds, newest first, at most
 *  `read.limit`, and fewer where Slack's page ran out first. */
export async function readTimeline(
  fetchPage: FetchHistoryPage,
  chatId: ChatId,
  read: TalkHistoryRead,
): Promise<ChannelMessage[]> {
  const channelId = chatId as string;
  if (read.newerThan !== undefined) return readForward(fetchPage, channelId, read);
  const since = read.since ? tsAt(read.since) : undefined;
  const until = read.until ? tsAt(read.until) : undefined;
  const within = (ts: string) =>
    (since === undefined || compareTs(ts, since) >= 0) &&
    (until === undefined || compareTs(ts, until) <= 0);
  // Below the read's own upper bound, whichever is lower.
  const bound = until !== undefined ? justAfter(until) : undefined;
  const latest =
    read.olderThan !== undefined && (bound === undefined || compareTs(read.olderThan, bound) < 0)
      ? read.olderThan
      : bound;
  const page = await fetchPage(channelId, latest !== undefined ? { latest } : {});
  const found: ChannelMessage[] = [];
  for (const { ts, message } of page.messages) {
    if (found.length >= read.limit) break;
    if (since !== undefined && compareTs(ts, since) < 0) break;
    if (within(ts)) found.push(message);
  }
  // An empty answer reads as the chat's start, so a page Slack answered with
  // none Rome reads says where to read on instead.
  if (found.length === 0 && page.messages.length === 0 && page.hasMore && page.oldest) {
    throw new Error(
      `Slack's page of chat ${channelId} held only messages Rome does not read, such as joins or edits, and Slack holds older ones. Read on with olderThan=${page.oldest}.`,
    );
  }
  return found;
}

/** The `limit` messages right after `newerThan`, newest first. */
async function readForward(
  fetchPage: FetchHistoryPage,
  channelId: string,
  read: TalkHistoryRead,
): Promise<ChannelMessage[]> {
  const from = read.newerThan as string;
  const until = read.until ? tsAt(read.until) : undefined;
  const since = read.since ? tsAt(read.since) : undefined;
  // Slack answers a chat newest first, so the page is the messages right
  // after `from` only when it holds every one of them.
  const page = await fetchPage(channelId, until !== undefined ? { latest: justAfter(until) } : {});
  const newer = page.messages.filter(({ ts }) => compareTs(ts, from) > 0);
  const wanted = newer.filter(({ ts }) => since === undefined || compareTs(ts, since) >= 0);
  // The page reaches the read's lower bound, `from` or `since`, once it
  // holds a message at or below it.
  const reaches = page.messages.some(
    ({ ts }) => compareTs(ts, from) <= 0 || (since !== undefined && compareTs(ts, since) <= 0),
  );
  if (!reaches && page.hasMore) {
    throw new Error(
      `More than ${page.messages.length} messages follow ${from} in Slack chat ${channelId}, and Slack answers its newest first. Read back from the newest with olderThan instead.`,
    );
  }
  return [...wanted]
    .reverse()
    .slice(0, read.limit)
    .reverse()
    .map(({ message }) => message);
}
