import { describe, expect, it } from "@rstest/core";
import { archivedDiscordThreads, type DiscordGet } from "./discord-threads.js";

// The archived threads of a Discord server, read page by page as Discord
// answers them.

const thread = (id: string, parent: string, archivedAt: string) => ({
  id,
  name: `thread ${id}`,
  parent_id: parent,
  thread_metadata: { archive_timestamp: archivedAt },
});

describe("archivedDiscordThreads", () => {
  it("reads every page of each chat's public and joined private archive, each thread once", async () => {
    const calls: string[] = [];
    const get: DiscordGet = async (route, query) => {
      calls.push(`${route}?${query}`);
      if (route === "/channels/1/threads/archived/public") {
        return query?.get("before")
          ? { threads: [thread("12", "1", "2026-01-01T00:00:00Z")], has_more: false }
          : { threads: [thread("11", "1", "2026-02-01T00:00:00Z")], has_more: true };
      }
      if (route === "/channels/1/users/@me/threads/archived/private") {
        // A private thread the bot joined, also named publicly: listed once.
        return { threads: [thread("13", "1", "2026-03-01T00:00:00Z")], has_more: false };
      }
      return { threads: [], has_more: false };
    };

    const threads = await archivedDiscordThreads(get, [
      { id: "1", holdsPrivateThreads: true },
      // A forum holds no private threads, so its private archive is not asked.
      { id: "2", holdsPrivateThreads: false },
    ]);

    expect(threads).toEqual([
      { id: "11", name: "thread 11", parentId: "1" },
      { id: "12", name: "thread 12", parentId: "1" },
      { id: "13", name: "thread 13", parentId: "1" },
    ]);
    expect(calls).toContain(
      "/channels/1/threads/archived/public?limit=100&before=2026-02-01T00%3A00%3A00Z",
    );
    expect(calls.some((call) => call.startsWith("/channels/2/users/"))).toBe(false);
  });

  it("skips a chat whose archive the bot may not see, and names a chat whose read fails", async () => {
    const refused: DiscordGet = async (route) => {
      if (route.startsWith("/channels/1/")) {
        throw Object.assign(new Error("Missing Access"), { status: 403 });
      }
      return { threads: [thread("21", "2", "2026-01-01T00:00:00Z")], has_more: false };
    };
    const broken: DiscordGet = async () => {
      throw Object.assign(new Error("Internal Server Error"), { status: 500 });
    };

    await expect(
      archivedDiscordThreads(refused, [
        { id: "1", holdsPrivateThreads: true },
        { id: "2", holdsPrivateThreads: true },
      ]),
    ).resolves.toEqual([{ id: "21", name: "thread 21", parentId: "2" }]);
    await expect(
      archivedDiscordThreads(broken, [{ id: "7", holdsPrivateThreads: false }]),
    ).rejects.toThrow(
      "Could not list the archived threads of Discord chat 7: Internal Server Error",
    );
  });
});
