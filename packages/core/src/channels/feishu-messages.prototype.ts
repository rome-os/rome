// PROTOTYPE — throwaway, untracked, and not wired into anything. It exists to
// answer one question from issue #182: can a `Messages` implementation answer
// the contract directly from Feishu's paged history API, with no mirror?
//
// Everything here is shaped after the real surface. The client interface
// mirrors `im.message.list` as `@larksuiteoapi/node-sdk@1.68.0` declares it
// (types/index.d.ts:257375-257425): one chat named by `container_id`, an
// optional time range in unix *seconds*, a create-time sort, `page_size` and
// `page_token`, answering `{ code, msg, data: { has_more, page_token, items } }`.
// The only method declared is the one the research note says the four reads
// would use — there is no count endpoint and no per-sender filter to declare.

import {
  compareTimelineEntries,
  isAfterTimelineCursor,
  type TimelineEntry,
} from "@rome/api-types/people";
import type { ConversationRead, MessageAccount, MessageRead, Messages } from "./messages.js";

/** The channel name the entries are sourced as. */
export const FEISHU = "feishu";

/** The API's own ceiling on `page_size` (docs: 1-50, default 20). */
export const FEISHU_MAX_PAGE_SIZE = 50;

/** "The bot can not be outside the group" — what `im.message.list` answers for
 *  a chat the tenant's bot is not a member of. */
export const BOT_NOT_IN_CHAT = 230002;

/** One message as `im.message.list` returns it. Fields the reads below never
 *  touch are left off; every one that is here carries the real type, including
 *  `create_time` being a string of epoch *milliseconds*. */
export interface FeishuMessageItem {
  message_id?: string;
  chat_id?: string;
  msg_type?: string;
  /** Epoch milliseconds, as a decimal string. */
  create_time?: string;
  deleted?: boolean;
  sender?: { id: string; id_type: string; sender_type: string };
  body?: { content: string };
}

export interface FeishuListParams {
  container_id_type: string;
  container_id: string;
  /** Epoch seconds, as a decimal string. */
  start_time?: string;
  /** Epoch seconds, as a decimal string. */
  end_time?: string;
  sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
  page_size?: number;
  page_token?: string;
}

export interface FeishuListResponse {
  code?: number;
  msg?: string;
  data?: { has_more?: boolean; page_token?: string; items?: FeishuMessageItem[] };
}

/** The one call a direct store would make, at the path the SDK exposes it on. */
export interface FeishuClient {
  im: { message: { list(payload: { params: FeishuListParams }): Promise<FeishuListResponse> } };
}

/** How `latest` is answered. */
export type LatestStrategy =
  /**
   * What `docs/research/channel-history/feishu-history.md` claims: "`latest` —
   * direct and cheap: `sort_type: "ByCreateTimeDesc"`, `page_size: 1` returns
   * the newest message in one call, satisfying the contract's 'first entry of
   * the full read'."
   */
  | "one-call"
  /**
   * The newest message in `compareTimelineEntries` order rather than in
   * create-time order: keep pulling until the whole of the newest second is in
   * hand, then rank it Rome's way.
   */
  | "whole-second";

export interface FeishuMessagesOptions {
  latest?: LatestStrategy;
  /** Clamped to the API's 1-50. Lowered in tests to put a page boundary
   *  inside a second on a fixture small enough to state. */
  pageSize?: number;
}

/**
 * `Messages` answered entirely by calling `client`, with nothing stored.
 *
 * `chatIdOf` is the map the research note says is the only way a p2p chat is
 * ever named: `GET /open-apis/im/v1/chats` excludes p2p chats, so a person's
 * chat id is learned from an inbound message or not at all. An address it
 * answers `undefined` for reaches no chat, and so reaches no history.
 */
export function feishuMessages(
  client: FeishuClient,
  chatIdOf: (accountAddress: string) => string | undefined,
  options: FeishuMessagesOptions = {},
): Messages {
  const latestStrategy = options.latest ?? "one-call";
  const pageSize = Math.min(Math.max(1, options.pageSize ?? FEISHU_MAX_PAGE_SIZE), FEISHU_MAX_PAGE_SIZE);

  /** The chats a set of accounts reaches, deduped: one p2p chat per address the
   *  map has heard of, and nothing for the addresses it has not. */
  const chatsOf = (accounts: readonly MessageAccount[]): string[] => {
    const ids = new Set<string>();
    for (const account of accounts) {
      if (account.channel !== FEISHU) continue;
      for (const address of account.addresses) {
        const chatId = chatIdOf(address);
        if (chatId) ids.add(chatId);
      }
    }
    return [...ids];
  };

  /**
   * One descending walk over `chatIds`, merged into one ranking and cut to
   * `limit` entries strictly after `after`.
   *
   * Two things force this to be a walk rather than a page fetch. The API ranks
   * by `create_time` in milliseconds; `TimelineEntry.timestamp` is whole
   * seconds and `compareTimelineEntries` re-ranks a tied second by direction,
   * putting an outbound reply *above* the inbound line it answers. So the two
   * orderings disagree inside every second that holds more than one message,
   * and a page that stopped mid-second would answer entries a later page also
   * answers. The loop therefore only commits an answer once every unfetched
   * message is provably in an older second than the last entry it would return.
   */
  const walk = async (
    chatIds: readonly string[],
    after: TimelineEntry | null,
    limit: number,
  ): Promise<TimelineEntry[]> => {
    const take = Math.max(1, Math.floor(limit));
    // A cursor's second bounds the walk: nothing after the cursor can sit in a
    // later second, so the descending walk starts at the cursor's own second
    // rather than at the newest message. Assumes `end_time` is inclusive.
    const endTime = after ? String(after.timestamp) : undefined;

    const walks = chatIds.map((id) => ({
      id,
      token: undefined as string | undefined,
      done: false,
      /** The second of the last item fetched: nothing unfetched from this chat
       *  is newer. Nothing fetched yet means no bound at all. */
      frontier: Number.POSITIVE_INFINITY,
    }));
    const seen = new Map<string, TimelineEntry>();

    for (;;) {
      const ranked = [...seen.values()]
        .sort(compareTimelineEntries)
        .filter((entry) => after === null || isAfterTimelineCursor(entry, after));
      const live = walks.filter((w) => !w.done);
      if (live.length === 0) return ranked.slice(0, take);

      const frontier = Math.max(...live.map((w) => w.frontier));
      const boundary = ranked[take - 1];
      if (boundary && boundary.timestamp > frontier) return ranked.slice(0, take);

      const next = live.reduce((a, b) => (b.frontier > a.frontier ? b : a));
      const response = await client.im.message.list({
        params: {
          container_id_type: "chat",
          container_id: next.id,
          sort_type: "ByCreateTimeDesc",
          page_size: pageSize,
          ...(endTime === undefined ? {} : { end_time: endTime }),
          ...(next.token === undefined ? {} : { page_token: next.token }),
        },
      });
      const items = itemsOf(response);
      for (const item of items) {
        const entry = toEntry(item);
        if (entry) seen.set(entry.ref, entry);
      }
      const last = items.at(-1);
      next.frontier = last ? secondsOf(last) : Number.NEGATIVE_INFINITY;
      next.token = response.data?.page_token;
      next.done = response.data?.has_more !== true || !next.token;
    }
  };

  const oneCallLatest = async (chatIds: readonly string[]): Promise<TimelineEntry | null> => {
    const heads = await Promise.all(
      chatIds.map(async (id) => {
        const response = await client.im.message.list({
          params: {
            container_id_type: "chat",
            container_id: id,
            sort_type: "ByCreateTimeDesc",
            page_size: 1,
          },
        });
        return itemsOf(response).map(toEntry).find((entry): entry is TimelineEntry => !!entry) ?? null;
      }),
    );
    return heads.filter((e): e is TimelineEntry => e !== null).sort(compareTimelineEntries)[0] ?? null;
  };

  return {
    async read(request: MessageRead) {
      return walk(chatsOf(request.accounts), request.after ?? null, request.limit);
    },

    // No count endpoint exists, so counting is walking the whole chat.
    async count(accounts) {
      return (await walk(chatsOf(accounts), null, Number.MAX_SAFE_INTEGER)).length;
    },

    async latest(accounts) {
      const chatIds = chatsOf(accounts);
      if (latestStrategy === "one-call") return oneCallLatest(chatIds);
      return (await walk(chatIds, null, 1))[0] ?? null;
    },

    async readConversation(request: ConversationRead) {
      if (request.conversation.channel !== FEISHU) return [];
      return walk([request.conversation.id], request.after ?? null, request.limit);
    },
  };
}

/**
 * The items of a response, or none.
 *
 * 230002 becomes an empty page rather than a throw, because the contract states
 * that "a conversation the store has never heard of and one it holds empty are
 * answered the same way". The platform does tell those two apart, so this
 * mapping spends a real distinction — "the bot may not read this chat" is
 * reported to a caller as "this chat is empty".
 */
function itemsOf(response: FeishuListResponse): FeishuMessageItem[] {
  if (response.code === BOT_NOT_IN_CHAT) return [];
  if (response.code !== undefined && response.code !== 0) {
    throw new Error(`im.message.list failed: ${response.code} ${response.msg ?? ""}`);
  }
  return response.data?.items ?? [];
}

const secondsOf = (item: FeishuMessageItem): number => Math.floor(Number(item.create_time ?? 0) / 1000);

/** A `TimelineEntry` from one item, or null for a message with no history in
 *  it. A deleted message is dropped: `im.message.get` refuses one (230110), so
 *  a store that counted it would count what no page can render. */
function toEntry(item: FeishuMessageItem): TimelineEntry | null {
  if (!item.message_id || item.deleted) return null;
  return {
    source: FEISHU,
    timestamp: secondsOf(item),
    // The bot is the only "app" sender in a p2p chat with it, so sender_type
    // is what says which way a message went.
    direction: item.sender?.sender_type === "app" ? "outbound" : "inbound",
    ref: item.message_id,
    body: textOf(item),
  };
}

function textOf(item: FeishuMessageItem): string | null {
  if (!item.body?.content) return null;
  try {
    const parsed = JSON.parse(item.body.content) as { text?: string };
    return parsed.text ?? item.body.content;
  } catch {
    return item.body.content;
  }
}

// ---------------------------------------------------------------------------
// The fake platform
// ---------------------------------------------------------------------------

export interface FeishuCallLog {
  /** Every `im.message.list` call made. */
  calls: FeishuListParams[];
  /** Message items handed back across every call. */
  items: number;
  reset(): void;
}

/**
 * A `FeishuClient` over a fixed set of chats, paging them the way the docs
 * describe: create-time order, a `page_size` clamped to 1-50, an opaque
 * `page_token`, an inclusive `start_time`/`end_time` range in whole seconds,
 * and 230002 for a chat the bot is not in.
 */
export function fakeFeishu(chats: Record<string, FeishuMessageItem[]>): {
  client: FeishuClient;
  log: FeishuCallLog;
} {
  const log: FeishuCallLog = {
    calls: [],
    items: 0,
    reset() {
      log.calls = [];
      log.items = 0;
    },
  };

  const client: FeishuClient = {
    im: {
      message: {
        async list({ params }) {
          log.calls.push(params);
          const held = chats[params.container_id];
          if (!held) return { code: BOT_NOT_IN_CHAT, msg: "Bot is not in the chat" };

          const size = Math.min(Math.max(1, params.page_size ?? 20), FEISHU_MAX_PAGE_SIZE);
          const start = params.start_time === undefined ? -Infinity : Number(params.start_time);
          const end = params.end_time === undefined ? Infinity : Number(params.end_time);
          const ordered = [...held]
            .filter((item) => secondsOf(item) >= start && secondsOf(item) <= end)
            // The platform's own ranking, by millisecond create time. Nothing
            // here knows about `compareTimelineEntries`.
            .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
          if (params.sort_type === "ByCreateTimeDesc") ordered.reverse();

          const offset = params.page_token ? Number(params.page_token) : 0;
          const items = ordered.slice(offset, offset + size);
          const hasMore = offset + items.length < ordered.length;
          log.items += items.length;
          return {
            code: 0,
            data: {
              items,
              has_more: hasMore,
              ...(hasMore ? { page_token: String(offset + items.length) } : {}),
            },
          };
        },
      },
    },
  };

  return { client, log };
}

/** One held message, stated the way the API returns it. `ms` is the create
 *  time in milliseconds, so a fixture can put two messages in one second. */
export function msg(
  chatId: string,
  id: string,
  ms: number,
  from: "user" | "app",
  text = id,
): FeishuMessageItem {
  return {
    message_id: id,
    chat_id: chatId,
    msg_type: "text",
    create_time: String(ms),
    deleted: false,
    sender: { id: from === "app" ? "cli_bot" : "ou_person", id_type: "open_id", sender_type: from },
    body: { content: JSON.stringify({ text }) },
  };
}
