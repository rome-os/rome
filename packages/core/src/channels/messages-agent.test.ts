import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import type { DrizzleDb } from "../db/index.js";
import type { Account } from "@rome-os/app-runtime";
import { chatAt, directMessageAt } from "../chats/adapter.js";
import type { ChatRef } from "../chats/place.js";
import { chatMessages, romeAgentMessages } from "../db/schema.js";
import { createTestDb } from "../test/helpers.js";
import { seatFixture } from "../test/seats.js";
import { ChatAddresses } from "./chat-addresses.js";
import {
  testAccountMessagesContract,
  WHOLE_HISTORY,
  type MessagesContractSubject,
} from "./messages-contract.js";
import { agentMessages, messageContentText } from "./messages-agent.js";

// `rome_agent_messages` read as an `AccountMessages` store, holding exactly what
// `agentMessagesSource` holds today: the roles that carry conversation, on
// channel sessions the account itself addresses.

const CHANNEL = "telegram";
/** The two addresses of the one account the fixtures speak to. */
const DIRECT = "tg-777";
const DIRECT_ALT = "tg-777-alt";
const GROUP = "tg-group-1";
const OTHER_CHANNEL = "discord";

const account = { channel: CHANNEL, addresses: [DIRECT, DIRECT_ALT] };
const silent = [{ channel: CHANNEL, addresses: ["tg-nobody"] }];

/** Rome's account on each channel the fixtures name. */
const ACCOUNTS: Record<string, Account> = {
  [CHANNEL]: { platform: "telegram", id: "rome-bot" },
  "tg-opaque": { platform: "telegram", id: "rome-opaque-bot" },
  [OTHER_CHANNEL]: { platform: "discord", id: "rome-discord" },
  webchat: { platform: "webchat", id: "agent:main" },
};
const accountOn = (channel: string): Account =>
  ACCOUNTS[channel] ?? { platform: channel, id: channel };
const read = (db: DrizzleDb) => agentMessages(db, accountOn);

/** Where each fixture seat stands, by seat id. */
const seats = new Map<string, { chat: ChatRef; account: Account; person: string }>();

function session(
  db: DrizzleDb,
  id: string,
  fields: { threadId: string; kind?: "dm" | "group"; channel?: string },
) {
  const fixture = seatFixture(db);
  const account = accountOn(fields.channel ?? CHANNEL);
  const kind = fields.kind ?? "dm";
  const chat =
    kind === "dm"
      ? directMessageAt(account, fields.threadId, new ChatAddresses(db))
      : chatAt(account.platform, fields.threadId);
  fixture.chat(chat.platform, chat.id, kind);
  fixture.seat({ id, chat, accountId: account.id, createdAt: new Date(0) });
  seats.set(id, { chat, account, person: fields.threadId });
}

/** A line said where seat `sessionId` stands: by the person, or by Rome
 *  when `role` is `assistant`. */
function message(
  db: DrizzleDb,
  id: string,
  fields: {
    sessionId: string;
    role: "user" | "assistant" | "notification";
    at: number;
    content?: string;
    senderId?: string;
  },
) {
  const seat = seats.get(fields.sessionId)!;
  const fromRome = fields.role === "assistant";
  const parts = fields.content ?? JSON.stringify([{ type: "text", content: id }]);
  db.insert(chatMessages)
    .values({
      id,
      chatId: seat.chat.id,
      threadId: null,
      senderAccountId: fields.senderId ?? (fromRome ? seat.account.id : seat.person),
      senderAgent: fromRome ? "main" : null,
      senderName: null,
      text: id,
      parts,
      saidAt: new Date(fields.at * 1000),
    })
    .run();
}

async function seed(db: DrizzleDb) {
  session(db, "s-direct", { threadId: DIRECT });
  session(db, "s-direct-alt", { threadId: DIRECT_ALT });
  session(db, "s-group", { threadId: GROUP, kind: "group" });
  session(db, "s-webchat", { threadId: "chat-1", channel: "webchat" });
  // Another channel spelling a thread id exactly as Telegram spells this
  // account's. Nothing but the pair keeps the two conversations apart.
  session(db, "s-elsewhere", { threadId: DIRECT, channel: OTHER_CHANNEL });

  // The same second twice, so the ordering and the cursor have a tie to settle.
  message(db, "m-hello", { sessionId: "s-direct", role: "user", at: 100 });
  message(db, "m-reply", { sessionId: "s-direct", role: "assistant", at: 100 });
  // A message that did not wake the agent is still something the person said.
  message(db, "m-note", { sessionId: "s-direct", role: "notification", at: 200 });
  message(db, "m-later", { sessionId: "s-direct", role: "user", at: 300 });
  // The account's other address: one history, not two halves of one.
  message(db, "m-alt", { sessionId: "s-direct-alt", role: "user", at: 250 });

  // Out of every account's scope, each for its own reason.
  // A trace belongs to no conversation.
  db.insert(romeAgentMessages)
    .values({
      id: "m-trace",
      sessionId: "s-direct",
      role: "trace",
      content: "[]",
      createdAt: new Date(400_000),
    })
    .run();
  // The group, which no account addresses. The first line was sent by the
  // account, and is still the group's.
  message(db, "m-group", { sessionId: "s-group", role: "user", at: 500, senderId: DIRECT });
  message(db, "m-group-reply", { sessionId: "s-group", role: "assistant", at: 500 });
  message(db, "m-group-note", { sessionId: "s-group", role: "notification", at: 520 });
  message(db, "m-group-later", { sessionId: "s-group", role: "user", at: 540 });
  message(db, "m-webchat", { sessionId: "s-webchat", role: "user", at: 600 });
  message(db, "m-elsewhere", { sessionId: "s-elsewhere", role: "user", at: 550 });
}

describe("agentMessages", () => {
  let db: DrizzleDb;
  let close: () => void;

  beforeEach(async () => {
    const test = createTestDb();
    db = test.db;
    close = test.close;
    await seed(db);
  });

  afterEach(() => close());

  const refs = async () =>
    (await read(db).read({ accounts: [account], limit: WHOLE_HISTORY })).map((entry) => entry.ref);

  // Exact, so it also pins what stays out: the trace row, which belongs to no
  // conversation; the group session, whoever sent into it; and the webchat
  // session, which is no channel's.
  it("answers the roles that carry conversation, newest first", async () => {
    expect(await refs()).toEqual([
      "agent:m-later",
      "agent:m-alt",
      "agent:m-note",
      "agent:m-reply",
      "agent:m-hello",
    ]);
  });

  it("answers nothing from a guardian chat, even stored as a channel row", async () => {
    session(db, "chat-1", { channel: "webchat", threadId: "chat-1" });
    message(db, "m-chat", { sessionId: "chat-1", role: "user", at: 700 });
    const page = await read(db).read({
      accounts: [{ channel: "webchat", addresses: ["chat-1"] }],
      limit: WHOLE_HISTORY,
    });
    expect(page).toEqual([]);
  });

  it("answers nothing to a group's own address, which is no account", async () => {
    const asGroup = await read(db).read({
      accounts: [{ channel: CHANNEL, addresses: [GROUP] }],
      limit: WHOLE_HISTORY,
    });
    expect(asGroup).toEqual([]);
  });

  it("names the sender and the conversation the transcript recorded", async () => {
    const page = await read(db).read({ accounts: [account], limit: WHOLE_HISTORY });
    const byRef = new Map(page.map((entry) => [entry.ref, entry]));
    expect(byRef.get("agent:m-later")?.conversation).toEqual({
      id: DIRECT,
      name: null,
      kind: "dm",
    });
    expect(byRef.get("agent:m-later")?.sender).toEqual({ id: DIRECT, name: null });
  });

  it("names the person as the sender and leaves Rome's own lines unattributed", async () => {
    await message(db, "m-rome", {
      sessionId: "s-direct",
      role: "notification",
      at: 350,
      senderId: "rome-bot",
    });
    await message(db, "m-person", {
      sessionId: "s-direct",
      role: "user",
      at: 360,
      senderId: DIRECT,
    });
    const page = await read(db).read({ accounts: [account], limit: WHOLE_HISTORY });
    const byRef = new Map(page.map((entry) => [entry.ref, entry]));
    // The sentinel log reads Rome's replies the same way.
    expect(byRef.get("agent:m-rome")).toMatchObject({ direction: "outbound" });
    expect(byRef.get("agent:m-rome")?.sender).toBeUndefined();
    expect(byRef.get("agent:m-person")?.sender).toEqual({ id: DIRECT, name: null });
  });

  it("names the channel as the source and the direction by the role", async () => {
    const page = await read(db).read({ accounts: [account], limit: WHOLE_HISTORY });
    expect(page.every((entry) => entry.source === CHANNEL)).toBe(true);
    const byRef = new Map(page.map((entry) => [entry.ref, entry]));
    expect(byRef.get("agent:m-reply")?.direction).toBe("outbound");
    expect(byRef.get("agent:m-hello")?.direction).toBe("inbound");
    expect(byRef.get("agent:m-note")?.direction).toBe("inbound");
  });

  // A line's direction is who said it: Rome's when one of its agents did, or
  // when it went out as Rome's own account, else the person's.
  describe("a line said without a turn", () => {
    it("reads one Rome's account sent out of band as outbound", async () => {
      message(db, "m-out-of-band", {
        sessionId: "s-direct",
        role: "notification",
        at: 950,
        senderId: "rome-bot",
      });
      expect(await read(db).latest([account])).toMatchObject({
        direction: "outbound",
        ref: "agent:m-out-of-band",
      });
    });

    // A sender id is a provider's own opaque string, so a person may be called
    // anything, Rome's name included.
    it("reads a person whose id reads as Rome's as inbound", async () => {
      message(db, "m-collision", {
        sessionId: "s-direct",
        role: "user",
        at: 950,
        senderId: "rome",
      });
      expect(await read(db).latest([account])).toMatchObject({ direction: "inbound" });
    });
  });

  it("renders a message as its text parts, joined", async () => {
    await message(db, "m-parts", {
      sessionId: "s-direct",
      role: "user",
      at: 700,
      content: JSON.stringify([
        { type: "text", content: "first" },
        { type: "tool_use", name: "search" },
        { type: "text", content: "second" },
      ]),
    });
    expect(await read(db).latest([account])).toMatchObject({
      ref: "agent:m-parts",
      body: "first\nsecond",
    });
  });

  it("answers a row with nothing to show rather than failing the read", async () => {
    await message(db, "m-card", {
      sessionId: "s-direct",
      role: "assistant",
      at: 800,
      content: JSON.stringify([{ type: "card", payload: {} }]),
    });
    await message(db, "m-broken", { sessionId: "s-direct", role: "user", at: 900, content: "{" });
    const page = await read(db).read({ accounts: [account], limit: 2 });
    expect(page.map((entry) => [entry.ref, entry.body])).toEqual([
      ["agent:m-broken", null],
      ["agent:m-card", null],
    ]);
  });

  it("scopes an address to its own channel", async () => {
    expect(await refs()).not.toContain("agent:m-elsewhere");
    const elsewhere = await read(db).read({
      accounts: [{ channel: OTHER_CHANNEL, addresses: [DIRECT] }],
      limit: WHOLE_HISTORY,
    });
    expect(elsewhere.map((entry) => entry.ref)).toEqual(["agent:m-elsewhere"]);
  });

  // The scope is carried into the batch as pairs, so two calls that name one
  // address on two channels are answered from one pass without either taking
  // the other's rows. A store bound to a single channel cannot be asked this.
  it("keeps two channels apart inside one batch", async () => {
    const messages = read(db);
    const [here, there] = await Promise.all([
      messages.read({ accounts: [account], limit: WHOLE_HISTORY }),
      messages.read({
        accounts: [{ channel: OTHER_CHANNEL, addresses: [DIRECT] }],
        limit: WHOLE_HISTORY,
      }),
    ]);
    expect(here.map((entry) => entry.ref)).not.toContain("agent:m-elsewhere");
    expect(there.map((entry) => entry.ref)).toEqual(["agent:m-elsewhere"]);
  });

  // A link keyed by a service names the service, and the transcript keys a
  // conversation by the account's own channel id, which may be opaque.
  it("reads an account under the channel it is stored under, and under none", async () => {
    session(db, "s-opaque", { threadId: DIRECT, channel: "tg-opaque" });
    message(db, "m-opaque", { sessionId: "s-opaque", role: "user", at: 450 });

    expect(await refs()).not.toContain("agent:m-opaque");
    const opaque = await read(db).read({
      accounts: [{ ...account, storedUnder: ["tg-opaque"] }],
      limit: WHOLE_HISTORY,
    });
    // Named by the account's own channel, the link's platform, as a reader asked.
    expect(opaque.map((entry) => [entry.ref, entry.source])).toEqual([["agent:m-opaque", CHANNEL]]);
    const none = await read(db).read({
      accounts: [{ ...account, storedUnder: [] }],
      limit: WHOLE_HISTORY,
    });
    expect(none).toEqual([]);
  });
});

// One seeded database for the whole suite: every assertion in it reads, so a
// fresh one per case would only buy migrations.
let enrolled: Promise<MessagesContractSubject> | null = null;

testAccountMessagesContract("agentMessages", () => {
  enrolled ??= (async () => {
    const { db } = createTestDb();
    await seed(db);
    return {
      messages: read(db),
      accounts: [account],
      silent,
    };
  })();
  return enrolled;
});

describe("messageContentText", () => {
  it("reads a dashboard answer without the narration that led to it", () => {
    const content = JSON.stringify([
      { type: "text", content: "Checking the fares.", turnPhase: "commentary" },
      { type: "task_chat", chatId: "task-1", title: "Flights" },
      { type: "text", content: "3 options", turnPhase: "final" },
    ]);

    expect(messageContentText(content)).toBe("3 options");
  });
});
