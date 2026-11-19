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

/** What a listing needs of Discord: a GET of a REST route. It rejects as
 *  discord.js does, with the HTTP `status` on the error. */
export type DiscordGet = (route: `/${string}`, query?: URLSearchParams) => Promise<unknown>;

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
    if (!page.has_more || !next || next === from) return threads;
    from = next;
  }
}

/**
 * The archived threads of each chat in `chatIds`, public and joined private,
 * each once. A chat whose archive the bot may not see contributes none. Any
 * other failure rejects, naming the chat.
 */
export async function archivedDiscordThreads(
  get: DiscordGet,
  chatIds: readonly string[],
): Promise<ArchivedThread[]> {
  const found = new Map<string, ArchivedThread>();
  for (const chatId of chatIds) {
    const archives = [
      // Public archives page by when a thread was archived.
      () =>
        archive(
          get,
          `/channels/${chatId}/threads/archived/public`,
          (thread) => thread.thread_metadata?.archive_timestamp,
        ),
      // Joined private archives page by thread id.
      () =>
        archive(
          get,
          `/channels/${chatId}/users/@me/threads/archived/private`,
          (thread) => thread.id,
        ),
    ];
    for (const read of archives) {
      let threads: WireThread[];
      try {
        threads = await read();
      } catch (err) {
        if (refusedAccess(err)) continue;
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Could not list the archived threads of Discord chat ${chatId}: ${reason}`);
      }
      for (const thread of threads) {
        found.set(thread.id, {
          id: thread.id,
          name: thread.name,
          parentId: thread.parent_id ?? chatId,
        });
      }
    }
  }
  return [...found.values()];
}
