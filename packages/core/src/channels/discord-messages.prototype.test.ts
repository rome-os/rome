// THROWAWAY PROTOTYPE TEST — see discord-messages.prototype.ts.

import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { sql } from "drizzle-orm";
import type { DrizzleDb } from "../db/index.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { testMessagesContract, WHOLE_HISTORY } from "./messages-contract.js";
import type { MessageAccount, MessageConversation } from "./messages.js";
import {
  backfillDiscord,
  createDiscordMirrorTable,
  discordMessages,
  type DiscordRest,
  type DiscordRestMessage,
} from "./discord-messages.prototype.js";

// ---------------------------------------------------------------------------
// The fake Discord
// ---------------------------------------------------------------------------

const BOT_A = "bot-a";
const BOT_B = "bot-b";
const ALICE = "u-alice";
const BOB = "u-bob";

const DM_A = "dm-a-alice";
const DM_B = "dm-b-alice";
const GUILD = "guild-general";
const GUILD_EMPTY = "guild-empty";

const msg = (id: string, author: string, at: number, content: string): DiscordRestMessage => ({
  id,
  author: { id: author },
  content,
  timestamp: new Date(at * 1000).toISOString(),
});

interface FakeRest extends DiscordRest {
  calls: Array<{ channelId: string; before?: string; limit: number }>;
}

/** `Get Channel Messages` as the docs describe it: newest first, `before`
 *  exclusive, at most `limit`, and no total anywhere. */
function fakeRest(channels: Record<string, DiscordRestMessage[]>): FakeRest {
  const calls: FakeRest["calls"] = [];
  return {
    calls,
    async channelMessages(channelId, query) {
      calls.push({ channelId, before: query.before, limit: query.limit });
      const all = [...(channels[channelId] ?? [])].sort((a, b) => Number(b.id) - Number(a.id));
      const from =
        query.before === undefined ? all : all.filter((m) => Number(m.id) < Number(query.before));
      return from.slice(0, query.limit);
    },
  };
}

// Bot A's DM with Alice: four messages, two of them in the same second, which
// is what the contract suite demands of an enrolled account.
const dmA = [
  msg("1001", ALICE, 100, "first"),
  msg("1002", BOT_A, 300, "answered"),
  msg("1003", ALICE, 300, "and again"),
  msg("1004", ALICE, 500, "latest"),
];
// Bot B's own DM with the same person. A different channel, different ids.
const dmB = [msg("3001", ALICE, 200, "hello other bot"), msg("3002", BOT_B, 400, "hi")];
// A guild channel both bots sit in. Both mirror the same message ids.
const guild = [
  msg("2001", ALICE, 700, "in the guild"),
  msg("2002", BOT_A, 700, "bot a answered the guild"),
  msg("2003", BOB, 750, "someone else"),
  msg("2004", ALICE, 760, "latest in the guild"),
];

const discord = fakeRest({ [DM_A]: dmA, [DM_B]: dmB, [GUILD]: guild, [GUILD_EMPTY]: [] });

const alice: MessageAccount[] = [{ channel: "discord", addresses: [ALICE] }];
const silent: MessageAccount[] = [{ channel: "discord", addresses: ["u-nobody"] }];
const guildConversation: MessageConversation = { channel: "discord", id: GUILD };
const emptyConversation: MessageConversation = { channel: "discord", id: GUILD_EMPTY };

/** Both connections mirrored, the way a two-bot deployment would leave the
 *  table. Bot A sees its own DM and the guild; bot B sees its own DM and the
 *  same guild. */
async function seedBothBots(db: DrizzleDb): Promise<void> {
  await backfillDiscord(db, discord, {
    account: BOT_A,
    channels: [{ id: DM_A, dmUserId: ALICE }, { id: GUILD }, { id: GUILD_EMPTY }],
  });
  await backfillDiscord(db, discord, {
    account: BOT_B,
    channels: [{ id: DM_B, dmUserId: ALICE }, { id: GUILD }],
  });
}

/** The whole mirror, for the "print the state" obligation. */
function mirror(db: DrizzleDb): Array<Record<string, unknown>> {
  return db.all(sql`
    SELECT bot_user_id, channel_id, id, author_id, dm_user_id, from_me, timestamp
    FROM discord_messages_prototype
    ORDER BY bot_user_id, channel_id, CAST(id AS INTEGER)`) as Array<Record<string, unknown>>;
}

function mirrorCount(db: DrizzleDb, where = sql`1=1`): number {
  const [row] = db.all(
    sql`SELECT count(*) AS n FROM discord_messages_prototype WHERE ${where}`,
  ) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

const refs = (entries: { ref: string }[]) => entries.map((entry) => entry.ref);

// ---------------------------------------------------------------------------

describe("discordMessages prototype", () => {
  let testDb: TestDb;

  beforeEach(async () => {
    testDb = createTestDb();
    createDiscordMirrorTable(testDb.db);
    discord.calls.length = 0;
    await seedBothBots(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("mirrors what the fake Discord holds, keyed by bot", () => {
    const rows = mirror(testDb.db);
    console.log("STATE after both backfills:", JSON.stringify(rows, null, 1));
    // 4 DM + 4 guild for bot A, 2 DM + 4 guild for bot B.
    expect(rows.length).toBe(14);
    expect(mirrorCount(testDb.db, sql`bot_user_id = ${BOT_A}`)).toBe(8);
    expect(mirrorCount(testDb.db, sql`bot_user_id = ${BOT_B}`)).toBe(6);
    // The guild's four messages are mirrored twice, once per connection. This
    // is exactly what wa_messages could not represent.
    expect(mirrorCount(testDb.db, sql`channel_id = ${GUILD}`)).toBe(8);
  });

  it("reads one bot's DM history newest first", async () => {
    const messages = discordMessages(testDb.db, { account: BOT_A });
    const page = await messages.read({ accounts: alice, limit: WHOLE_HISTORY });
    console.log("STATE bot-a account read:", JSON.stringify(page));
    expect(refs(page)).toEqual([
      `${DM_A}:1004`,
      `${DM_A}:1002`,
      `${DM_A}:1003`,
      `${DM_A}:1001`,
    ]);
    expect(page[0]).toEqual({
      source: "discord",
      timestamp: 500,
      direction: "inbound",
      ref: `${DM_A}:1004`,
      body: "latest",
    });
    expect(await messages.count(alice)).toBe(4);
    expect(await messages.latest(alice)).toEqual(page[0]);
  });

  it("keeps a guild channel out of every account read", async () => {
    const messages = discordMessages(testDb.db, { account: BOT_A });
    const page = await messages.read({ accounts: alice, limit: WHOLE_HISTORY });
    expect(refs(page).some((ref) => ref.startsWith(GUILD))).toBe(false);
    // Nor to a caller handing the channel id over as if it were an address.
    const asAccount: MessageAccount[] = [{ channel: "discord", addresses: [GUILD] }];
    expect(await messages.count(asAccount)).toBe(0);
    expect(await messages.latest(asAccount)).toBeNull();
  });

  it("answers the guild channel as a conversation", async () => {
    const messages = discordMessages(testDb.db, { account: BOT_A });
    const page = await messages.readConversation({
      conversation: guildConversation,
      limit: WHOLE_HISTORY,
    });
    console.log("STATE bot-a conversation read:", JSON.stringify(page));
    expect(refs(page)).toEqual([
      `${GUILD}:2004`,
      `${GUILD}:2003`,
      `${GUILD}:2002`,
      `${GUILD}:2001`,
    ]);
  });

  // -------------------------------------------------------------------------
  // Multi-account keying
  // -------------------------------------------------------------------------

  describe("two connected bots on one channel key", () => {
    it("keeps two bots' DMs with one person apart when the store is scoped", async () => {
      const fromA = await discordMessages(testDb.db, { account: BOT_A }).read({
        accounts: alice,
        limit: WHOLE_HISTORY,
      });
      const fromB = await discordMessages(testDb.db, { account: BOT_B }).read({
        accounts: alice,
        limit: WHOLE_HISTORY,
      });
      console.log("STATE scoped A:", refs(fromA), "scoped B:", refs(fromB));
      expect(refs(fromA).every((ref) => ref.startsWith(DM_A))).toBe(true);
      expect(refs(fromB)).toEqual([`${DM_B}:3002`, `${DM_B}:3001`]);
      expect(refs(fromA).some((ref) => ref.startsWith(DM_B))).toBe(false);
      expect(refs(fromB).some((ref) => ref.startsWith(DM_A))).toBe(false);
    });

    it("bleeds both bots' DMs into one history when the store is not scoped", async () => {
      const messages = discordMessages(testDb.db);
      const page = await messages.read({ accounts: alice, limit: WHOLE_HISTORY });
      console.log("STATE unscoped account read:", refs(page));
      // Six, not four: Alice's conversation with bot A and her separate
      // conversation with bot B are one history to a caller that cannot say
      // which connection it is asking about.
      expect(refs(page)).toEqual([
        `${DM_A}:1004`,
        `${DM_B}:3002`,
        `${DM_A}:1002`,
        `${DM_A}:1003`,
        `${DM_B}:3001`,
        `${DM_A}:1001`,
      ]);
      expect(await messages.count(alice)).toBe(6);
    });

    it("shows a shared guild message twice when the two bots disagree on its direction", async () => {
      const scoped = await discordMessages(testDb.db, { account: BOT_A }).readConversation({
        conversation: guildConversation,
        limit: WHOLE_HISTORY,
      });
      const unscoped = await discordMessages(testDb.db).readConversation({
        conversation: guildConversation,
        limit: WHOLE_HISTORY,
      });
      console.log("STATE guild scoped:", scoped.length, "unscoped:", JSON.stringify(unscoped));

      expect(scoped.length).toBe(4);
      // Leaving bot_user_id out of `ref` lets sqlMessages' DISTINCT fold the two
      // mirrors of each guild message back into one — for every message except
      // the one bot A sent, which is outbound in bot A's mirror and inbound in
      // bot B's. Direction is a projected column, so the fold cannot reach it.
      expect(unscoped.length).toBe(5);
      const doubled = refs(unscoped).filter((ref) => ref === `${GUILD}:2002`);
      expect(doubled.length).toBe(2);
      expect(unscoped.filter((e) => e.ref === `${GUILD}:2002`).map((e) => e.direction)).toEqual([
        "outbound",
        "inbound",
      ]);
    });

    it("doubles a shared guild channel outright when the ref carries the account", async () => {
      const messages = discordMessages(testDb.db, { refCarriesAccount: true });
      const page = await messages.readConversation({
        conversation: guildConversation,
        limit: WHOLE_HISTORY,
      });
      console.log("STATE guild, ref carries account:", refs(page));
      // Eight entries for a four-message channel, and a count to match. Nothing
      // in the contract catches this: count still equals the length of the full
      // read, every ref is distinct, and the pages still exhaust cleanly. The
      // history is simply wrong.
      expect(page.length).toBe(8);
      expect(await messages.count(alice)).toBe(6);
    });
  });

  // -------------------------------------------------------------------------
  // The backfill
  // -------------------------------------------------------------------------

  describe("backfill", () => {
    const HORIZON = "horizon-channel";
    const bulk = (count: number, from = 0) =>
      Array.from({ length: count }, (_, i) =>
        msg(String(10000 + from + i), ALICE, 1000 + from + i, `line ${from + i}`),
      );

    it("reaches all 350 messages of a channel, oldest included", async () => {
      const history = bulk(350);
      const rest = fakeRest({ [HORIZON]: history });
      const run = await backfillDiscord(testDb.db, rest, {
        account: BOT_A,
        channels: [{ id: HORIZON, dmUserId: ALICE }],
      });
      console.log("STATE backfill run:", run, "cursors:", JSON.stringify(rest.calls));

      expect(run).toEqual({ calls: 4, seen: 350, written: 350 });
      expect(mirrorCount(testDb.db, sql`channel_id = ${HORIZON}`)).toBe(350);

      // The horizon claim in full: the store answers the whole channel, and its
      // oldest entry is the channel's oldest message and not the sync's start.
      const conversation: MessageConversation = { channel: "discord", id: HORIZON };
      const messages = discordMessages(testDb.db, { account: BOT_A });
      const page = await messages.readConversation({ conversation, limit: WHOLE_HISTORY });
      console.log("STATE horizon read:", page.length, page[0]?.ref, page.at(-1)?.ref);
      expect(page.length).toBe(350);
      expect(page[0]?.ref).toBe(`${HORIZON}:10349`);
      expect(page.at(-1)?.ref).toBe(`${HORIZON}:10000`);
      // The cursors walked strictly backwards, page by page.
      expect(rest.calls.map((call) => call.before)).toEqual([
        undefined,
        "10250",
        "10150",
        "10050",
      ]);
    });

    it("writes nothing on a rerun and picks up what arrived since", async () => {
      const history = bulk(350);
      const channels = [{ id: HORIZON, dmUserId: ALICE }];

      const first = await backfillDiscord(testDb.db, fakeRest({ [HORIZON]: history }), {
        account: BOT_A,
        channels,
      });
      const again = await backfillDiscord(testDb.db, fakeRest({ [HORIZON]: history }), {
        account: BOT_A,
        channels,
      });
      console.log("STATE first:", first, "rerun:", again);
      expect(again).toEqual({ calls: 4, seen: 350, written: 0 });
      expect(mirrorCount(testDb.db, sql`channel_id = ${HORIZON}`)).toBe(350);

      const grown = [...history, ...bulk(3, 350)];
      const third = await backfillDiscord(testDb.db, fakeRest({ [HORIZON]: grown }), {
        account: BOT_A,
        channels,
      });
      console.log("STATE after growth:", third);
      // The whole channel walked again — 353 seen — but only the three new rows
      // written. Idempotence is the primary key's, not the walk's.
      expect(third).toEqual({ calls: 4, seen: 353, written: 3 });
      expect(mirrorCount(testDb.db, sql`channel_id = ${HORIZON}`)).toBe(353);

      const messages = discordMessages(testDb.db, { account: BOT_A });
      const page = await messages.readConversation({
        conversation: { channel: "discord", id: HORIZON },
        limit: WHOLE_HISTORY,
      });
      expect(page.length).toBe(353);
      expect(page[0]?.ref).toBe(`${HORIZON}:10352`);
    });

    // ceil(N/100) except when N divides evenly, where the walk pays one extra
    // call to learn the channel is exhausted — the endpoint returns no total,
    // so a short page is the only end-of-history signal there is.
    it.each([
      { held: 0, calls: 1 },
      { held: 1, calls: 1 },
      { held: 99, calls: 1 },
      { held: 100, calls: 2 },
      { held: 101, calls: 2 },
      { held: 200, calls: 3 },
      { held: 350, calls: 4 },
    ])("costs $calls REST calls for a channel of $held messages", async ({ held, calls }) => {
      const rest = fakeRest({ [HORIZON]: bulk(held) });
      const run = await backfillDiscord(testDb.db, rest, {
        account: BOT_A,
        channels: [{ id: HORIZON, dmUserId: ALICE }],
      });
      console.log(`STATE N=${held}:`, run);
      expect(run.calls).toBe(calls);
      expect(run.seen).toBe(held);
      const predicted = held % 100 === 0 ? held / 100 + 1 : Math.ceil(held / 100);
      expect(run.calls).toBe(predicted);
    });
  });
});

// The contract, over a mirror the backfill filled — not over hand-written rows.
testMessagesContract("discordMessages prototype", async () => {
  const testDb = createTestDb();
  createDiscordMirrorTable(testDb.db);
  await seedBothBots(testDb.db);
  return {
    messages: discordMessages(testDb.db, { account: BOT_A }),
    accounts: alice,
    silent,
    conversation: guildConversation,
    silentConversation: emptyConversation,
  };
});

// The same contract over the store the channel list as it stands could actually
// hold: one Discord entry, every connected bot folded together.
testMessagesContract("discordMessages prototype (unscoped, both bots)", async () => {
  const testDb = createTestDb();
  createDiscordMirrorTable(testDb.db);
  await seedBothBots(testDb.db);
  return {
    messages: discordMessages(testDb.db),
    accounts: alice,
    silent,
    conversation: guildConversation,
    silentConversation: emptyConversation,
  };
});

// And over the store that answers a four-message guild channel with eight
// entries. Enrolled to find out whether the suite objects.
testMessagesContract("discordMessages prototype (unscoped, ref carries account)", async () => {
  const testDb = createTestDb();
  createDiscordMirrorTable(testDb.db);
  await seedBothBots(testDb.db);
  return {
    messages: discordMessages(testDb.db, { refCarriesAccount: true }),
    accounts: alice,
    silent,
    conversation: guildConversation,
    silentConversation: emptyConversation,
  };
});
