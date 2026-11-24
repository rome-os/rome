import type { DiscordGet } from "./discord-history.js";

/**
 * The threads a Discord server has archived, read from Discord's REST API:
 * the public ones in each chat, and the private ones the bot has joined.
 * The gateway names only the threads still active, so a listing that has to
 * reach every thread asks Discord for the rest.
 */

/** A thread as Discord's REST API spells it, in the fields read here. */
interface WireThread {
  id: string;
  name: string;
  parent_id?: string | null;
  thread_metadata?: { archive_timestamp?: string };
}

interface WireThreadPage {
  threads: WireThread[];
  has_more: boolean;
}

/** One archived thread, and the chat it is in. */
export interface ArchivedThread {
  id: string;
  name: string;
  parentId: string;
}

const PAGE = 100;

/** Whether Discord refused the read because the bot may not see the chat's
 *  archive: it lacks Read Message History there. Such a chat holds no
 *  archived thread the account can see, so the listing goes on without it. */
function refusedAccess(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { status } = err as { status?: unknown };
  return status === 403;
}

/** Every page of one archive of `chatId`. `before` turns a page's last
 *  thread into where the next page starts. */
async function archive(
  get: DiscordGet,
  route: `/${string}`,
  before: (thread: WireThread) => string | undefined,
): Promise<WireThread[]> {
  const threads: WireThread[] = [];
  let from: string | undefined;
  for (;;) {
    const query = new URLSearchParams({ limit: String(PAGE) });
    if (from) query.set("before", from);
    const page = (await get(route, query)) as WireThreadPage;
    threads.push(...page.threads);
    const last = page.threads.at(-1);
    const next = last ? before(last) : undefined;
    if (!page.has_more) return threads;
    // A page that leaves the cursor where it was would end the listing short.
    if (!next || next === from)
      throw new Error(`Discord's archive at ${route} stopped paging before its end`);
    from = next;
  }
}

/** A chat whose archive a listing reads. Only a text chat holds private
 *  threads. */
export interface ArchivedChat {
  id: string;
  holdsPrivateThreads: boolean;
}

/** How many chats' archives are read at once. Discord limits each chat's
 *  route on its own, so a few at once stay within them. */
const CONCURRENT_CHATS = 4;

/**
 * The archived threads of each chat in `chats`, public and joined private,
 * each once. A chat whose archive the bot may not see contributes none. Any
 * other failure rejects, naming the chat.
 */
export async function archivedDiscordThreads(
  get: DiscordGet,
  chats: readonly ArchivedChat[],
): Promise<ArchivedThread[]> {
  const found = new Map<string, ArchivedThread>();
  const queue = [...chats];
  const worker = async () => {
    try {
      for (let chat = queue.shift(); chat; chat = queue.shift()) {
        for (const thread of await archivedIn(get, chat)) found.set(thread.id, thread);
      }
    } catch (err) {
      // The listing has failed: the other workers read no further chats.
      queue.length = 0;
      throw err;
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT_CHATS }, worker));
  return [...found.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

/** One chat's archived threads: public ones, and the private ones the bot
 *  joined where the chat can hold any. */
async function archivedIn(get: DiscordGet, chat: ArchivedChat): Promise<ArchivedThread[]> {
  const chatId = chat.id;
  const archives = [
    // Public archives page by when a thread was archived.
    () =>
      archive(
        get,
        `/channels/${chatId}/threads/archived/public`,
        (thread) => thread.thread_metadata?.archive_timestamp,
      ),
    // Joined private archives page by thread id.
    ...(chat.holdsPrivateThreads
      ? [
          () =>
            archive(
              get,
              `/channels/${chatId}/users/@me/threads/archived/private`,
              (thread) => thread.id,
            ),
        ]
      : []),
  ];
  const threads: ArchivedThread[] = [];
  for (const read of archives) {
    let page: WireThread[];
    try {
      page = await read();
    } catch (err) {
      if (refusedAccess(err)) continue;
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not list the archived threads of Discord chat ${chatId}: ${reason}`);
    }
    for (const thread of page) {
      threads.push({ id: thread.id, name: thread.name, parentId: thread.parent_id ?? chatId });
    }
  }
  return threads;
}
