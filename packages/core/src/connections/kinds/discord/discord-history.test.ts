import { describe, expect, it } from "@rstest/core";
import {
  type DiscordGet,
  type WireChannel,
  type WireMessage,
  readDiscordHistory,
} from "./discord-history.js";

// A chat's history read from Discord itself: Discord's REST paging, modelled
// by a fake that answers as Discord does, newest first and at most 100.

const BOT = "100000000000000001";
const CHAT = "100000000000000003";
const THREAD = "100000000000000005";
const EPOCH = 1420070400000;
const T0 = Date.UTC(2026, 10, 19, 8, 0, 0);

/** The id Discord gives the message said `n` seconds after T0. */
function idAt(n: number): string {
  return String(BigInt(T0 + n * 1000 - EPOCH) << 22n);
}

function said(n: number, extra: Partial<WireMessage> = {}, channel = CHAT): WireMessage {
  return {
    id: idAt(n),
    type: 0,
    channel_id: channel,
    content: `message ${n}`,
    timestamp: new Date(T0 + n * 1000).toISOString(),
    author: { id: "200000000000000001", username: "ada", global_name: "Ada" },
    ...extra,
  };
}

/** Discord over `chats`: each channel by id, each with its messages. */
function discord(chats: Record<string, { channel: WireChannel; messages: WireMessage[] }>) {
  const calls: string[] = [];
  const get: DiscordGet = async (route, query) => {
    calls.push(query ? `${route}?${query}` : route);
    const [, , id, messages] = route.split("/");
    const chat = chats[id!];
    if (!chat) throw Object.assign(new Error("Unknown Channel"), { status: 404, code: 10003 });
    if (!messages) return chat.channel;
    const limit = Number(query?.get("limit") ?? 50);
    const before = query?.get("before");
    const after = query?.get("after");
    const oldestFirst = [...chat.messages].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
    if (after) {
      // The `limit` messages right after it, newest first.
      return oldestFirst
        .filter((m) => BigInt(m.id) > BigInt(after))
        .slice(0, limit)
        .reverse();
    }
    return oldestFirst
      .filter((m) => !before || BigInt(m.id) < BigInt(before))
      .slice(-limit)
      .reverse();
  };
  return { get, calls };
}

const deps = (get: DiscordGet) => ({ get, botId: BOT, textOf: (content: string) => content });
const textChannel: WireChannel = { id: CHAT, type: 0, name: "general" };
const seconds = (messages: { messageId: string }[]) =>
  messages.map((m) => (Number((BigInt(m.messageId) >> 22n) + BigInt(EPOCH)) - T0) / 1000);

describe("readDiscordHistory", () => {
  const messages = Array.from({ length: 250 }, (_, n) => said(n));
  const chats = { [CHAT]: { channel: textChannel, messages } };

  it("reads the newest messages back past one Discord page, newest first", async () => {
    const { get, calls } = discord(chats);

    const page = await readDiscordHistory(deps(get), CHAT, { limit: 150 });

    expect(seconds(page)).toEqual(Array.from({ length: 150 }, (_, n) => 249 - n));
    expect(calls).toEqual([
      `/channels/${CHAT}`,
      `/channels/${CHAT}/messages?limit=100`,
      `/channels/${CHAT}/messages?limit=100&before=${idAt(150)}`,
    ]);
  });

  it("reads older than a message, and newer than one, the page right beside it", async () => {
    const { get } = discord(chats);

    const older = await readDiscordHistory(deps(get), CHAT, { olderThan: idAt(100), limit: 3 });
    const newer = await readDiscordHistory(deps(get), CHAT, { newerThan: idAt(100), limit: 3 });

    expect(seconds(older)).toEqual([99, 98, 97]);
    // Newest first, and the first is where the next page forward starts.
    expect(seconds(newer)).toEqual([103, 102, 101]);
  });

  it("pages forward past one Discord page until it reaches the newest", async () => {
    const { get } = discord(chats);

    const newer = await readDiscordHistory(deps(get), CHAT, { newerThan: idAt(10), limit: 1000 });

    expect(newer).toHaveLength(239);
    expect(seconds(newer).at(0)).toBe(249);
    expect(seconds(newer).at(-1)).toBe(11);
  });

  it("reads between two instants, both inclusive", async () => {
    const { get } = discord(chats);

    const page = await readDiscordHistory(deps(get), CHAT, {
      since: new Date(T0 + 20_000),
      until: new Date(T0 + 23_000),
      limit: 100,
    });

    expect(seconds(page)).toEqual([23, 22, 21, 20]);
  });

  it("names the thread a message opened, and reads the thread by its id", async () => {
    const opener = said(1, { thread: { id: THREAD } });
    const created = said(2, {
      type: 18,
      content: "plans",
      message_reference: { channel_id: THREAD },
    });
    const system = said(3, { type: 7 });
    const inThread = said(4, { author: { id: BOT, username: "rome" } }, THREAD);
    const { get } = discord({
      [CHAT]: { channel: textChannel, messages: [opener, created, system] },
      [THREAD]: {
        channel: { id: THREAD, type: 11, name: "plans", parent_id: CHAT },
        messages: [inThread],
      },
    });

    const chat = await readDiscordHistory(deps(get), CHAT, { limit: 10 });
    const thread = await readDiscordHistory(deps(get), THREAD, { limit: 10 });

    // A member joining (type 7) is no message said.
    expect(chat.map((m) => [m.messageId, m.openedThread, m.text])).toEqual([
      [created.id, THREAD, 'started thread "plans"'],
      [opener.id, THREAD, "message 1"],
    ]);
    expect(thread).toEqual([
      expect.objectContaining({
        chatId: THREAD,
        parentChatId: CHAT,
        direction: "outbound",
        thread: { kind: "topic", name: "plans" },
      }),
    ]);
  });

  it("says when the account may not read the chat, or sees no such chat", async () => {
    const refused: DiscordGet = async () => {
      throw Object.assign(new Error("Missing Access"), { status: 403, code: 50001 });
    };
    const { get } = discord(chats);

    await expect(readDiscordHistory(deps(refused), CHAT, { limit: 1 })).rejects.toThrow(
      `This Discord account may not read chat ${CHAT}`,
    );
    await expect(readDiscordHistory(deps(get), "999", { limit: 1 })).rejects.toThrow(
      "This Discord account sees no chat 999",
    );
  });

  it("refuses a guild chat whose history the bot may not read, where Discord answers none", async () => {
    // Discord answers a bot without Read Message History an empty page.
    const { get } = discord({ [CHAT]: { channel: textChannel, messages: [] } });

    await expect(
      readDiscordHistory({ ...deps(get), readsHistoryIn: async () => false }, CHAT, { limit: 5 }),
    ).rejects.toThrow(`This Discord account may not read chat ${CHAT}`);
    await expect(
      readDiscordHistory({ ...deps(get), readsHistoryIn: async () => true }, CHAT, { limit: 5 }),
    ).resolves.toEqual([]);
  });

  it("names a sender by their nickname in the guild, as a message heard live does", async () => {
    const { get } = discord({
      [CHAT]: { channel: { ...textChannel, guild_id: "300" }, messages: [said(1)] },
    });

    const page = await readDiscordHistory(
      {
        ...deps(get),
        nicknameOf: (guild, user) => (guild === "300" ? `nick of ${user}` : undefined),
      },
      CHAT,
      { limit: 5 },
    );

    expect(page[0]?.senderDisplayName).toBe("nick of 200000000000000001");
  });

  it("refuses a read whose permission it cannot tell, and an id that is no Discord id", async () => {
    const { get, calls } = discord(chats);

    await expect(
      readDiscordHistory({ ...deps(get), readsHistoryIn: async () => null }, CHAT, { limit: 5 }),
    ).rejects.toThrow(`Cannot tell yet whether this Discord account may read chat ${CHAT}`);
    await expect(
      readDiscordHistory(deps(get), CHAT, { olderThan: "m1", limit: 5 }),
    ).rejects.toThrow('olderThan "m1" is no Discord id');
    await expect(readDiscordHistory(deps(get), "../users/@me", { limit: 5 })).rejects.toThrow(
      "chatId",
    );
    expect(calls).toEqual([`/channels/${CHAT}`]);
  });

  it("asks for whole pages, and says where to read on after a few spare ones of system messages", async () => {
    const joins = Array.from({ length: 1000 }, (_, n) => said(n, { type: 7 }));
    const { get, calls } = discord({ [CHAT]: { channel: textChannel, messages: joins } });

    // One page the limit needs, and five spare, then where to read on.
    await expect(readDiscordHistory(deps(get), CHAT, { limit: 1 })).rejects.toThrow(
      `Read on with olderThan=${idAt(400)}.`,
    );
    expect(calls.filter((call) => call.includes("/messages"))).toHaveLength(6);
  });

  it("reads a DM by its own chat id, and never opens one for a user's id", async () => {
    const dm = "100000000000000004";
    const { get, calls } = discord({
      [dm]: { channel: { id: dm, type: 1 }, messages: [said(1, {}, dm)] },
    });

    const page = await readDiscordHistory(deps(get), dm, { limit: 5 });

    expect(page).toEqual([expect.objectContaining({ chatId: dm, thread: { kind: "dm" } })]);
    await expect(readDiscordHistory(deps(get), "200000000000000001", { limit: 5 })).rejects.toThrow(
      "This Discord account sees no chat 200000000000000001",
    );
    expect(calls.every((call) => !call.includes("/users/"))).toBe(true);
  });
});
