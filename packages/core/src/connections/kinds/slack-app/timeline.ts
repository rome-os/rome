// A chat's history as the Slack app connection reads it: from its copy of the
// chat's timeline where the copy can tell it holds every message there, and
// from Slack's conversations.history where it cannot. Contract: `TalkHistory`
// (connections/types.ts).
//
// The copy knows a message comes right before another only when the
// connection saw both with nothing between them:
//   - two messages next to each other on one page Slack answered;
//   - two messages heard one after the other in one drain of the mailbox, in
//     a direct message, where the app hears every message, its own included;
//   - a message the connection sent, right after the newest it had heard in
//     that drain.
// The drain counts because the mailbox holds every event Rome Cloud deposits
// until the connection takes it, in order, while the instance is stopped
// too. Each start opens a new drain and forgets the last, so what came before
// is a break. A message heard out of order shows a link around it wrong, and
// the copy forgets that link. Anything else is a break, and the read asks
// Slack from the break rather than guess. So a message that reached Slack and
// never the instance still shows in a read: the copy holds no link over it.
//
// Slack lets an app read one page of a conversation a minute, of up to 15
// messages, so a read asks Slack at most once. It answers what it has, which
// may be fewer than its limit: a reader reads on from the oldest message.

import type { ChannelMessage, ChatId } from "@rome-os/app-runtime";
import type { TalkHistoryRead } from "../../types.js";
import type { SlackMessageCopy, TimelineRow } from "./message-copy.js";
import { compareTs, tsAt } from "./timeline-order.js";

/** One page of a chat's history as Slack answered it, newest first. */
export interface SlackHistoryPage {
  messages: Array<{ ts: string; message: ChannelMessage }>;
  /** Whether Slack holds older messages than the page within its bounds. */
  hasMore: boolean;
}

/** One request for a page: only messages before `latest` (exclusive). */
export type FetchHistoryPage = (
  channelId: string,
  bounds: { latest?: string },
) => Promise<SlackHistoryPage>;

export interface SlackTimelineDeps {
  teamId: string;
  copy: SlackMessageCopy;
  fetchPage: FetchHistoryPage;
  /** The newest message heard in each direct message in this drain, by chat. */
  heads: Map<string, string>;
  /** Whether a message newer than a page's newest would be heard in this
   *  drain: true in a direct message while a drain is open. */
  hearsEvery: (channelId: string) => boolean;
}

/** One microsecond later, so an inclusive bound reads as an exclusive one. */
function justAfter(ts: string): string {
  const [seconds, micros = "0"] = ts.split(".");
  const next = Number(micros.padEnd(6, "0")) + 1;
  return next >= 1_000_000
    ? `${Number(seconds) + 1}.000000`
    : `${seconds}.${String(next).padStart(6, "0")}`;
}

/** Note a message the connection heard or sent in a direct message, in the
 *  drain open now. A message heard twice is noted once. */
export function noteInDrain(
  deps: SlackTimelineDeps,
  channelId: string,
  ts: string,
  message: ChannelMessage,
): void {
  if (deps.copy.timelineRow(deps.teamId, channelId, ts)) return;
  const head = deps.heads.get(channelId);
  const follows = head !== undefined && compareTs(head, ts) < 0;
  deps.copy.keepRun(deps.teamId, channelId, {
    messages: [{ ts, message }],
    before: follows ? head : null,
  });
  if (head === undefined || follows) deps.heads.set(channelId, ts);
}

/** The messages of `chatId` within `read`'s bounds, newest first, at most
 *  `read.limit`, and fewer where Slack's page ran out first. */
export async function readTimeline(
  deps: SlackTimelineDeps,
  chatId: ChatId,
  read: TalkHistoryRead,
): Promise<ChannelMessage[]> {
  const channelId = chatId as string;
  if (read.newerThan !== undefined) return readForward(deps, channelId, read);
  const since = read.since ? tsAt(read.since) : undefined;
  const until = read.until ? tsAt(read.until) : undefined;
  const within = (ts: string) =>
    (since === undefined || compareTs(ts, since) >= 0) &&
    (until === undefined || compareTs(ts, until) <= 0);
  const found: ChannelMessage[] = [];
  const row = (ts: string) => deps.copy.timelineRow(deps.teamId, channelId, ts);

  // `above` is the message just above the next one to take, when the copy
  // holds it; `next` is that next one: "" past the chat's first message,
  // null when the copy does not know.
  let above: string | undefined;
  let next: string | null;
  if (read.olderThan !== undefined) {
    above = read.olderThan;
    next = row(read.olderThan)?.prevTs ?? null;
  } else {
    // With no upper bound, the newest message heard in this drain is the
    // chat's newest.
    next = deps.heads.get(channelId) ?? null;
  }
  while (found.length < read.limit) {
    if (next === "") return found;
    const current: TimelineRow | null = next === null ? null : row(next);
    if (!current) break;
    if (since !== undefined && compareTs(current.ts, since) < 0) return found;
    if (within(current.ts)) found.push(current.message);
    above = current.ts;
    next = current.prevTs;
  }
  if (found.length >= read.limit) return found;

  // The copy does not know what comes next: ask Slack, below the last
  // message taken or below the read's own bound.
  const latest = above ?? (until !== undefined ? justAfter(until) : undefined);
  const page = await deps.fetchPage(channelId, latest !== undefined ? { latest } : {});
  deps.copy.keepRun(deps.teamId, channelId, {
    messages: page.messages,
    before: page.hasMore ? null : "",
    ...(above !== undefined ? { after: above } : {}),
  });
  // Slack's newest, read with no upper bound: anything newer is heard in the
  // drain, so it heads the chat unless a newer one was heard meanwhile.
  const newest = page.messages[0]?.ts;
  if (latest === undefined && newest !== undefined && deps.hearsEvery(channelId)) {
    const head = deps.heads.get(channelId);
    if (head === undefined || compareTs(head, newest) < 0) deps.heads.set(channelId, newest);
  }
  for (const { ts, message } of page.messages) {
    if (found.length >= read.limit) break;
    if (since !== undefined && compareTs(ts, since) < 0) break;
    if (within(ts)) found.push(message);
  }
  return found;
}

/** The `limit` messages right after `newerThan`, newest first. */
async function readForward(
  deps: SlackTimelineDeps,
  channelId: string,
  read: TalkHistoryRead,
): Promise<ChannelMessage[]> {
  const from = read.newerThan as string;
  const until = read.until ? tsAt(read.until) : undefined;
  const since = read.since ? tsAt(read.since) : undefined;
  const found: TimelineRow[] = [];
  const head = deps.heads.get(channelId);
  let current = from;
  let known = deps.copy.timelineRow(deps.teamId, channelId, from) !== null;
  // Whether the copy reached the chat's newest message or the read's bound.
  let ended = false;
  while (known && found.length < read.limit) {
    if (current === head) {
      ended = true;
      break;
    }
    const after = deps.copy.timelineAfter(deps.teamId, channelId, current);
    if (!after) {
      known = false;
      break;
    }
    if (until !== undefined && compareTs(after.ts, until) > 0) {
      ended = true;
      break;
    }
    found.push(after);
    current = after.ts;
  }
  const done = known && (found.length >= read.limit || ended);
  if (!done) {
    // Slack answers a chat newest first, so the page is the messages right
    // after `from` only when it holds every one of them.
    const page = await deps.fetchPage(
      channelId,
      until !== undefined ? { latest: justAfter(until) } : {},
    );
    deps.copy.keepRun(deps.teamId, channelId, { messages: page.messages, before: null });
    const newer = page.messages.filter(({ ts }) => compareTs(ts, from) > 0);
    if (newer.length === page.messages.length && page.hasMore) {
      throw new Error(
        `More than ${page.messages.length} messages follow ${from} in Slack chat ${channelId}, and Slack answers its newest first. Read back from the newest with olderThan instead.`,
      );
    }
    found.length = 0;
    for (const { ts, message } of [...newer].reverse()) {
      if (found.length >= read.limit) break;
      found.push({ ts, prevTs: null, message });
    }
  }
  return found
    .filter(({ ts }) => since === undefined || compareTs(ts, since) >= 0)
    .reverse()
    .map(({ message }) => message);
}
