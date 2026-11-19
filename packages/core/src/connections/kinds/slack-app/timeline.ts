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
  /** Each with the ts of its last edit, when Slack shows one. */
  messages: Array<{ ts: string; message: ChannelMessage; editedTs?: string }>;
  /** Whether Slack holds older messages than the page within its bounds. */
  hasMore: boolean;
  /** The oldest message Slack answered, kept or not: a page of only joins
   *  or edits keeps none, while Slack holds older messages below it. */
  oldest?: string;
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
   *  drain: true in a direct message while a drain is open, unless a post the
   *  app sent there has not come back as an event yet. */
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
 *  drain open now. One the copy holds already, such as from a page Slack
 *  answered before its event arrived, still moves the drain on past the head:
 *  the next one heard comes after it. Its link is written only where the copy had none,
 *  since a link from Slack's page is the surer of the two. */
export function noteInDrain(
  deps: SlackTimelineDeps,
  channelId: string,
  ts: string,
  message: ChannelMessage,
): void {
  const head = deps.heads.get(channelId);
  const follows = head !== undefined && compareTs(head, ts) < 0;
  const held = deps.copy.timelineRow(deps.teamId, channelId, ts);
  // A drain's first message never heads the chat: it may be Slack sending a
  // backlog, such as a retry into a new drain, and newer messages may have
  // been said since, whether or not the copy holds them. The chat's newest is
  // known again once a read with no upper bound asks Slack (readTimeline).
  const heads = follows;
  if (!held) {
    deps.copy.keepRun(deps.teamId, channelId, {
      messages: [{ ts, message }],
      before: follows ? head : null,
    });
  } else if (follows && held.prevTs === null) {
    deps.copy.keepRun(deps.teamId, channelId, {
      messages: [{ ts, message: held.message }],
      before: head,
    });
  }
  if (heads) deps.heads.set(channelId, ts);
}

/** The chat's newest message, as the drain knows it, or undefined when the
 *  drain does not hear every message there. A head the copy holds newer
 *  messages than is not trusted: a page read below a later message can keep
 *  messages newer than one heard late, and the chat's newest is then unknown. */
function headOf(deps: SlackTimelineDeps, channelId: string): string | undefined {
  if (!deps.hearsEvery(channelId)) return undefined;
  const head = deps.heads.get(channelId);
  if (head === undefined || deps.copy.holdsNewer(deps.teamId, channelId, head)) return undefined;
  return head;
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
  const found: Array<{ ts: string; message: ChannelMessage }> = [];
  const answer = () => found.map(({ message }) => message);
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
    // chat's newest, while the drain hears every message there.
    next = headOf(deps, channelId) ?? null;
  }
  while (found.length < read.limit) {
    if (next === "") return answer();
    const current: TimelineRow | null = next === null ? null : row(next);
    if (!current) break;
    if (since !== undefined && compareTs(current.ts, since) < 0) return answer();
    if (within(current.ts)) found.push({ ts: current.ts, message: current.message });
    above = current.ts;
    next = current.prevTs;
  }
  if (found.length >= read.limit) return answer();

  // The copy does not know what comes next: ask Slack, below the last
  // message taken or below the read's own bound.
  // Below the last message taken, which the page then links to, unless that
  // is still newer than the read's own bound: then below the bound, with no
  // link, since the messages between are not read.
  const bound = until !== undefined ? justAfter(until) : undefined;
  const adjacent = above !== undefined && (bound === undefined || compareTs(above, bound) <= 0);
  const latest = adjacent ? above : bound;
  const page = await deps.fetchPage(channelId, latest !== undefined ? { latest } : {});
  // What the copy answered before the page arrived, as it holds it now: an
  // edit or a deletion may have arrived meanwhile.
  const held = found.splice(0).flatMap(({ ts }) => {
    const now = row(ts);
    return now ? [{ ts, message: now.message }] : [];
  });
  found.push(...held);
  // The page as the copy keeps it: a change that arrived while it was read
  // is taken.
  const kept = deps.copy.keepRun(deps.teamId, channelId, {
    messages: page.messages,
    before: page.hasMore ? null : "",
    ...(adjacent ? { after: above } : {}),
  });
  // Slack's newest, read with no upper bound: anything newer is heard in the
  // drain, so it heads the chat unless a newer one was heard meanwhile.
  const newest = kept[0]?.ts;
  if (latest === undefined && newest !== undefined && deps.hearsEvery(channelId)) {
    const head = deps.heads.get(channelId);
    if (head === undefined || compareTs(head, newest) < 0) deps.heads.set(channelId, newest);
  }
  for (const { ts, message } of kept) {
    if (found.length >= read.limit) break;
    if (since !== undefined && compareTs(ts, since) < 0) break;
    if (within(ts)) found.push({ ts, message });
  }
  // An empty answer reads as the chat's start, so a page Slack answered with
  // none Rome reads says where to read on instead.
  if (found.length === 0 && kept.length === 0 && page.hasMore && page.oldest) {
    throw new Error(
      `Slack's page of chat ${channelId} held only messages Rome does not read, such as joins or edits, and Slack holds older ones. Read on with olderThan=${page.oldest}.`,
    );
  }
  return answer();
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
  const head = headOf(deps, channelId);
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
    // Messages before the read's lower bound take no room on the page.
    if (since === undefined || compareTs(after.ts, since) >= 0) found.push(after);
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
    const kept = deps.copy.keepRun(deps.teamId, channelId, {
      messages: page.messages,
      before: null,
    });
    const newer = kept.filter(({ ts }) => compareTs(ts, from) > 0);
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
    found.length = 0;
    for (const { ts, message } of [...wanted].reverse()) {
      if (found.length >= read.limit) break;
      found.push({ ts, prevTs: null, message });
    }
  }
  return found.reverse().map(({ message }) => message);
}
