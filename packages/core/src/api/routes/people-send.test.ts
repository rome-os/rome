import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type {
  LinkedAccount,
  PersonResource,
  SendRefusal,
  SentMessage,
  TimelinePage,
} from "@rome/api-types/people";
import { peopleRoutes } from "./people.js";
import { accountsRoutes } from "./accounts.js";
import {
  createTestConnections,
  createTestDb,
  buildTestDeps,
  testChannels,
  type TestDb,
  type TestDeps,
} from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import {
  channels as channelRows,
  connectionGrants,
  romeAgentMessages,
  romeSessions,
} from "../../db/schema.js";
import { channelList } from "../../channels/channel-list.js";
import { channelChatId } from "../../db/session-kind.js";
import { conversationPlatformMessageId } from "../../db/repositories/webchat.js";

// Sending to a person.
//
// What these pin is the rule the surface rests on: a send names the account it
// is for and Rome never chooses one, and the answer says whether the channel
// took the message, with the channel's own words when it did not.

const TG = "tg-send-target";
const OTHER_TG = "tg-someone-else";

describe("People send API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let personId: string;
  afterEach(() => {
    rs.useRealTimers();
  });

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", peopleRoutes(deps));

    personId = await deps.peopleRepo.create({
      displayName: "Send Target",
      bondLevel: "acquaintance",
      approved: true,
      links: [{ platform: "telegram", id: TG }],
    });
  });

  const send = (body: unknown, id = personId) =>
    app.request(`/people/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const timeline = async (id = personId): Promise<TimelinePage> => {
    const res = await app.request(`/people/${id}/messages`);
    return (await res.json()) as TimelinePage;
  };

  const accountOf = async (channel: string): Promise<LinkedAccount> => {
    const res = await app.request(`/people/${personId}`);
    const person = (await res.json()) as PersonResource;
    return person.accounts.find((account) => account.channel === channel)!;
  };

  it("sends to the account the request names, and answers that the channel took it", async () => {
    const res = await send({ channel: "telegram", channelUserId: TG, text: "on my way" });

    expect(res.status).toBe(200);
    const sent = (await res.json()) as SentMessage;
    expect(sent.ref).toMatch(new RegExp(`^${TG}:`));
    expect(sent.timestamp).toBeGreaterThan(0);
    expect((await timeline()).entries.map((entry) => entry.body)).toContain("on my way");

    expect(deps.transports.get("telegram")?.sentMessages).toEqual([
      { chatId: TG, message: { text: "on my way" } },
    ]);
  });

  it("refuses an account the person does not hold", async () => {
    const res = await send({ channel: "telegram", channelUserId: OTHER_TG, text: "hello" });

    // Not a 404 and not a silent redirect to an account they do hold: the
    // guardian addressed someone, and delivering to anyone else is worse than
    // refusing.
    expect(res.status).toBe(400);
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
  });

  it("refuses a channel that does not do direct messaging, naming the state", async () => {
    const connections = createTestConnections(deps.transports, (_service, talk) => ({
      ...talk,
      directMessaging: undefined,
    }));
    const readOnly = { ...deps, connections, channels: testChannels(deps, connections) };
    const readOnlyApp = new Hono().route("/", peopleRoutes(readOnly));

    const res = await readOnlyApp.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: TG, text: "hello" }),
    });

    expect(res.status).toBe(409);
    // The same state the person read carries, so a client that raced a
    // disconnect renders the reason it would already have shown.
    expect((await res.json()) as SendRefusal).toMatchObject({ send: "unsupported" });
  });

  it("refuses a body naming no account or no text", async () => {
    expect((await send({ channel: "telegram", text: "hi" })).status).toBe(400);
    expect((await send({ channel: "telegram", channelUserId: TG, text: "  " })).status).toBe(400);
  });

  // Nothing is kept for a message the channel did not take: the guardian still
  // holds the text, and sending it again is a new send.
  it("answers a refused send with the channel's words, and records nothing", async () => {
    rs.spyOn(deps.transports.get("telegram")!, "send").mockRejectedValue(
      new Error("provider rejected"),
    );

    const res = await send({ channel: "telegram", channelUserId: TG, text: "will fail" });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "provider rejected" });
    expect((await timeline()).entries.map((entry) => entry.body)).not.toContain("will fail");
  });

  it("says on the person read whether each account can be written to", async () => {
    const account = await accountOf("telegram");
    expect(account.send).toBe("yes");
    // Nothing has happened on it yet, which is a different answer from zero.
    expect(account.latestAt).toBeNull();

    await send({ channel: "telegram", channelUserId: TG, text: "now there is history" });
    expect((await accountOf("telegram")).latestAt).toBeGreaterThan(0);
  });

  it("reports a channel with no connection as not-connected", async () => {
    await app.request(`/people/${personId}/accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "signal", channelUserId: "sig-1" }),
    });
    const account = await accountOf("signal");
    expect(account.send).toBe("not-connected");
  });
});

describe("People send API — after the channel answers", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let personId: string;

  // A WhatsApp contact reachable two ways. WhatsApp addresses one person by
  // phone JID and by privacy LID, holds a chat under each, and folds both onto
  // one account — so a message sent to one can be echoed back under the other.
  const PN = "15550007777@s.whatsapp.net";
  const LID = "77770000@lid";

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db, { channels: ["whatsapp", "telegram"] });
    app = new Hono().route("/", peopleRoutes(deps));

    await deps.whatsAppStoreRepo.upsertContacts([
      { jid: PN, phoneNumber: "15550007777", name: "Folded Contact" },
      { jid: LID, phoneNumber: "15550007777", name: "Folded Contact" },
    ]);

    // Linked by the LID, which is the half of the fold a send would address.
    personId = await deps.peopleRepo.create({
      displayName: "Folded Contact",
      bondLevel: "acquaintance",
      approved: true,
      links: [{ platform: "whatsapp", id: LID }],
    });
  });

  it("keeps a delivered send delivered when Rome's own record of it fails", async () => {
    // The provider accepted the message: it is out on a network Rome does not
    // own. A local write failing afterwards cannot take it back, and reporting
    // the send as failed invites a retry that delivers a second real message.
    deps.webchatRepo.recordOutboundConversationMessage = async () => {
      throw new Error("disk is full");
    };

    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", channelUserId: LID, text: "went out anyway" }),
    });

    expect(res.status).toBe(200);
  });

  it("answers no-conversation when the channel throws looking for a thread", async () => {
    // What a thread-keyed channel does when it cannot open a DM. The person
    // read already calls this account `no-conversation`; the send path has to
    // agree rather than answering with a stack trace.
    const connections = createTestConnections(deps.transports, (_service, talk) => ({
      ...talk,
      directMessaging: {
        chatFor: async () => {
          throw new Error("provider is down");
        },
      },
    }));
    const throwing = { ...deps, connections, channels: testChannels(deps, connections) };

    const res = await new Hono()
      .route("/", peopleRoutes(throwing))
      .request(`/people/${personId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "whatsapp", channelUserId: LID, text: "no thread" }),
      });

    expect(res.status).toBe(409);
    expect((await res.json()) as SendRefusal).toMatchObject({ send: "no-conversation" });
  });
});

// A first account connected into an empty database with an opaque channel id.
// People keys the link by the service, and the account's conversation lives
// under the opaque id, so both the send and the timeline have to reach across.
describe("People on an account whose channel id is opaque", () => {
  const OPAQUE = "0b5c6d1e-9a8f-4c3b-8e2d-7f6a5b4c3d2e";
  const ADA = "tg-ada";
  /** Rome's own Telegram accounts, on the opaque channel and a second one. */
  const ME = { platform: "telegram", id: "tg-me" };
  const SECOND = { platform: "telegram", id: "tg-me-second" };
  /** A live grant on `custody` reaching `account`, which is what backs a
   *  channel that knows its account. */
  const grant = (custody: string, account: { platform: string; id: string }) =>
    testDb.db
      .insert(connectionGrants)
      .values({ custody, state: "authorized", platform: account.platform, accountId: account.id })
      .run();
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let personId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    const base = await buildTestDeps(testDb.db);
    testDb.db
      .insert(channelRows)
      .values({
        id: OPAQUE,
        connectionKind: "telegram",
        platform: "telegram",
        platformAccountId: ME.id,
        connectionId: "test:telegram",
        createdAt: new Date(0),
      })
      .run();
    grant("test:telegram", ME);
    deps = {
      ...base,
      channels: channelList({
        db: base.db,
        whatsAppAccounts: base.whatsAppAccounts,
        linkedInAccounts: base.linkedInAccounts,
        connections: {
          registry: base.connections,
          channelOf: (connection) =>
            connection.connectionKind === "telegram" ? OPAQUE : connection.connectionKind,
        },
        laterChannels: [{ name: OPAQUE, connectionKind: "telegram" }],
      }),
    };
    app = new Hono().route("/", peopleRoutes(deps));

    personId = await deps.peopleRepo.create({
      displayName: "Ada",
      bondLevel: "acquaintance",
      approved: true,
      links: [{ platform: "telegram", id: ADA }],
    });

    // What Ada said to that account, as Rome's transcript holds it.
    const sessionId = channelChatId(OPAQUE, ADA);
    testDb.db
      .insert(romeSessions)
      .values({
        id: sessionId,
        name: sessionId,
        type: "channel",
        sourceChannel: OPAQUE,
        sourceThreadId: ADA,
        sourceThreadType: "private",
        createdAt: new Date(0),
        activityAt: new Date(0),
      })
      .run();
    testDb.db
      .insert(romeAgentMessages)
      .values({
        id: "m-ada",
        sessionId,
        role: "user",
        content: JSON.stringify([{ type: "text", content: "hello from Ada" }]),
        senderId: ADA,
        createdAt: new Date(1_000_000),
      })
      .run();
  });

  const person = async (): Promise<PersonResource> =>
    (await (await app.request(`/people/${personId}`)).json()) as PersonResource;

  const timeline = async (): Promise<TimelinePage> =>
    (await (await app.request(`/people/${personId}/messages`)).json()) as TimelinePage;

  it("links the account under its connection kind and reads it as sendable", async () => {
    expect((await person()).accounts).toMatchObject([
      { channel: "telegram", channelUserId: ADA, send: "yes" },
    ]);
  });

  it("shows the account's conversation on the person's timeline", async () => {
    const entries = (await timeline()).entries;
    expect(entries.map((entry) => entry.body)).toEqual(["hello from Ada"]);
    // Named by the link's key, which is the account's channel on the wire, so
    // a client's per-account view of the timeline holds it.
    expect(entries[0]?.source).toBe("telegram");
  });

  it("sends on the opaque account and sees the message land in its conversation", async () => {
    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: ADA, text: "hi Ada" }),
    });

    expect(res.status).toBe(200);
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([
      { chatId: ADA, message: { text: "hi Ada" } },
    ]);
    // Rome's line joins the conversation the account already holds, rather
    // than one under the service's name.
    const entries = (await timeline()).entries;
    expect(entries.map((entry) => [entry.body, entry.source])).toEqual([
      ["hi Ada", "telegram"],
      ["hello from Ada", "telegram"],
    ]);
    const held = testDb.db
      .select({ sessionId: romeAgentMessages.sessionId })
      .from(romeAgentMessages)
      .all();
    expect(held.map((row) => row.sessionId)).toEqual([
      channelChatId(OPAQUE, ADA),
      channelChatId(OPAQUE, ADA),
    ]);
  });

  // Rome never picks among its accounts on a platform: with a second one
  // connected, the link is sendable from either, but a send has to name one.
  // History reads across both.
  it("sends from neither of two accounts on one platform unless the send names one", async () => {
    testDb.db
      .insert(channelRows)
      .values({
        id: "tg-second",
        connectionKind: "telegram",
        platform: "telegram",
        platformAccountId: SECOND.id,
        connectionId: "test:telegram-second",
        createdAt: new Date(0),
      })
      .run();
    grant("test:telegram-second", SECOND);

    expect((await person()).accounts).toMatchObject([
      { channel: "telegram", channelUserId: ADA, send: "yes", from: [ME, SECOND] },
    ]);
    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: ADA, text: "hi Ada" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as SendRefusal).toMatchObject({ send: "not-connected" });
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    expect((await timeline()).entries.map((entry) => entry.body)).toEqual(["hello from Ada"]);
  });

  // A disconnect releases the channel and the next boot builds none for it,
  // but what Ada said to that account stays stored under its name.
  it("still reads the history told to an account Rome has disconnected", async () => {
    testDb.db.delete(connectionGrants).where(eq(connectionGrants.custody, "test:telegram")).run();
    testDb.db
      .update(channelRows)
      .set({ connectionId: null })
      .where(eq(channelRows.id, OPAQUE))
      .run();
    const rebooted: TestDeps = {
      ...deps,
      channels: channelList({
        db: deps.db,
        whatsAppAccounts: deps.whatsAppAccounts,
        linkedInAccounts: deps.linkedInAccounts,
      }),
    };
    app = new Hono().route("/", peopleRoutes(rebooted)).route("/", accountsRoutes(rebooted));

    expect((await timeline()).entries.map((entry) => entry.body)).toEqual(["hello from Ada"]);
    const stream = (await (await app.request("/accounts/stream")).json()) as {
      accounts: Array<{ channel: string; channelUserId: string }>;
    };
    expect(stream.accounts).toContainEqual(
      expect.objectContaining({ channel: "telegram", channelUserId: ADA }),
    );
  });

  // Two of Rome's accounts hold Ada's history in two different stores: an old
  // transcript under a released account, and a recent exchange only the
  // sentinel triaged under the live one. Each channel's history comes from its
  // own store, so neither hides the other.
  it("reads each of Rome's accounts' history from the store that holds it", async () => {
    testDb.db.delete(romeAgentMessages).run();
    testDb.db
      .insert(channelRows)
      .values({
        id: "tg-old",
        connectionKind: "telegram",
        platform: "telegram",
        createdAt: new Date(0),
      })
      .run();
    const oldSession = channelChatId("tg-old", ADA);
    testDb.db
      .insert(romeSessions)
      .values({
        id: oldSession,
        name: oldSession,
        type: "channel",
        sourceChannel: "tg-old",
        sourceThreadId: ADA,
        sourceThreadType: "private",
        createdAt: new Date(0),
        activityAt: new Date(0),
      })
      .run();
    testDb.db
      .insert(romeAgentMessages)
      .values({
        id: "m-old",
        sessionId: oldSession,
        role: "user",
        content: JSON.stringify([{ type: "text", content: "said long ago" }]),
        senderId: ADA,
        createdAt: new Date(1_000_000),
      })
      .run();
    await deps.sentinelLogRepo.create({
      messageId: "tg-recent",
      channel: OPAQUE,
      channelUserId: ADA,
      displayName: "Ada",
      text: "said just now",
      action: "escalated",
    });

    expect((await timeline()).entries.map((entry) => entry.body)).toEqual([
      "said just now",
      "said long ago",
    ]);
    expect((await person()).latest?.preview).toBe("said just now");
    const stream = (await (
      await new Hono().route("/", accountsRoutes(deps)).request("/accounts/stream")
    ).json()) as { accounts: Array<{ channelUserId: string; latest: { preview: string } }> };
    expect(stream.accounts.find((row) => row.channelUserId === ADA)?.latest.preview).toBe(
      "said just now",
    );
  });

  describe("naming the account a send goes out from", () => {
    const post = (body: Record<string, unknown>) =>
      app.request(`/people/${personId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "telegram", channelUserId: ADA, ...body }),
      });

    /** A second Telegram account, connected after the first. */
    const connectSecond = () => {
      testDb.db
        .insert(channelRows)
        .values({
          id: "tg-second",
          connectionKind: "telegram",
          platform: "telegram",
          platformAccountId: SECOND.id,
          connectionId: "test:telegram-second",
          createdAt: new Date(60_000),
        })
        .run();
      grant("test:telegram-second", SECOND);
    };

    it("lists the accounts a send may go out from on the person read", async () => {
      expect((await person()).accounts[0]?.from).toEqual([ME]);
      connectSecond();
      expect((await person()).accounts[0]?.from).toEqual([ME, SECOND]);
    });

    it("sends from the account it names", async () => {
      const res = await post({ text: "from the opaque account", from: ME });

      expect(res.status).toBe(200);
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([
        { chatId: ADA, message: { text: "from the opaque account" } },
      ]);
    });

    it("refuses an account of another connection kind, or one Rome does not hold", async () => {
      for (const from of [
        "telegram",
        { platform: "webchat", id: ME.id },
        { platform: "telegram", id: "tg-unknown" },
      ]) {
        const res = await post({ text: "hello", from });
        expect(res.status).toBe(400);
      }
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    });

    it("sends from a named account of two, and refuses a send that names none", async () => {
      connectSecond();

      expect((await post({ text: "which one?" })).status).toBe(409);
      const res = await post({ text: "from the first", from: ME });
      expect(res.status).toBe(200);
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([
        { chatId: ADA, message: { text: "from the first" } },
      ]);
    });
  });
});
