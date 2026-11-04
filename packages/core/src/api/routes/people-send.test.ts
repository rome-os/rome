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
import {
  createTestConnections,
  createTestDb,
  buildTestDeps,
  ownedByGuardian,
  testChannels,
  type TestDb,
  type TestDeps,
} from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import { sayOnChannel } from "../../test/speakers.js";
import { channels as channelRows, chatMessages, connectionGrants } from "../../db/schema.js";
import { channelList } from "../../chats/connected-accounts/connected-account-list.js";

// Sending to a person.
//
// What these pin is the rule the surface rests on: a send names the account it
// is for and Rome never chooses one, it goes out only from the guardian's own
// connected accounts, and the answer says whether the channel took the
// message, with the channel's own words when it did not.

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
    ownedByGuardian(testDb.db, deps.peopleRepo, "guardian", [
      { channel: "telegram", platform: "telegram" },
    ]);
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
    const res = await app.request(`/people/${id}/messages?channel=telegram&channelUserId=${TG}`);
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
    // Said in Chats, in the direct message with the account, which is what
    // the person's timeline reads.
    expect(
      testDb.db.all<{ kind: string; text: string }>(
        sql`SELECT c.kind, m.text FROM chat_messages m JOIN chats c ON c.id = m.chat_id`,
      ),
    ).toEqual([{ kind: "dm", text: "on my way" }]);
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

    const res = await send({
      channel: "telegram",
      channelUserId: TG,
      text: "now there is history",
    });
    expect(res.status).toBe(200);
    expect((await accountOf("telegram")).latestAt).toBeGreaterThan(0);
  });

  it("sends only from the guardian's own accounts", async () => {
    // The Telegram channel's account is an agent's once the guardian no longer
    // holds it, so a person's page cannot send there: the message would land
    // in a chat the page does not show.
    await deps.peopleRepo.unlink({ platform: "telegram", id: "guardian-on-telegram" });

    expect((await accountOf("telegram")).send).toBe("not-connected");
    const res = await send({ channel: "telegram", channelUserId: TG, text: "hello" });
    expect(res.status).toBe(409);
    expect((await res.json()) as SendRefusal).toMatchObject({ send: "not-connected" });
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
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
    ownedByGuardian(testDb.db, deps.peopleRepo, "guardian", [
      { channel: "whatsapp", platform: "whatsapp" },
    ]);
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
    // Both of Rome's Telegram accounts here are the guardian's own, so a
    // person's page reads and sends through either.
    await seedBaseline(testDb.db);
    base.peopleRepo.linkStated(ME, "guardian");
    base.peopleRepo.linkStated(SECOND, "guardian");
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

    // What Ada said to that account, as Chats holds it.
    sayOnChannel(deps, {
      channel: OPAQUE,
      address: ADA,
      key: "m-ada",
      text: "hello from Ada",
      at: new Date(1_000_000),
    });
  });

  const person = async (): Promise<PersonResource> =>
    (await (await app.request(`/people/${personId}`)).json()) as PersonResource;

  const timeline = async (): Promise<TimelinePage> =>
    (await (
      await app.request(`/people/${personId}/messages?channel=telegram&channelUserId=${ADA}`)
    ).json()) as TimelinePage;

  it("links the account under its connection kind and reads it as sendable", async () => {
    expect((await person()).accounts).toMatchObject([
      { channel: "telegram", channelUserId: ADA, send: "yes" },
    ]);
  });

  it("shows the account's conversation on its timeline", async () => {
    const entries = (await timeline()).entries;
    expect(entries.map((entry) => entry.body)).toEqual(["hello from Ada"]);
    // Named by the link's key, which is the account's channel on the wire.
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
    // Rome's line joins the conversation the account already holds, said in
    // Chats as the opaque account's.
    const entries = (await timeline()).entries;
    expect(entries.map((entry) => [entry.body, entry.source])).toEqual([
      ["hi Ada", "telegram"],
      ["hello from Ada", "telegram"],
    ]);
    expect(
      testDb.db.all<{ kind: string; account: string | null; text: string }>(sql`
        SELECT c.kind, m.sender_account_id AS account, m.text
        FROM chat_messages m JOIN chats c ON c.id = m.chat_id ORDER BY m.id
      `),
    ).toEqual([
      { kind: "dm", account: ADA, text: "hello from Ada" },
      { kind: "dm", account: ME.id, text: "hi Ada" },
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
    app = new Hono().route("/", peopleRoutes(rebooted));

    expect((await timeline()).entries.map((entry) => entry.body)).toEqual(["hello from Ada"]);
  });

  // A released account whose record knows no account is nobody's, so not the
  // guardian's, and the triage record is not a chat with the guardian: what
  // Ada said through either is not on her page.
  it("reads neither the triage record nor an account that is not the guardian's", async () => {
    testDb.db.delete(chatMessages).run();
    testDb.db
      .insert(channelRows)
      .values({
        id: "tg-old",
        connectionKind: "telegram",
        platform: "telegram",
        createdAt: new Date(0),
      })
      .run();
    sayOnChannel(deps, {
      channel: "tg-old",
      address: ADA,
      key: "m-old",
      text: "said long ago",
      at: new Date(1_000_000),
    });
    await deps.sentinelLogRepo.create({
      messageId: "tg-recent",
      channel: OPAQUE,
      channelUserId: ADA,
      displayName: "Ada",
      text: "said just now",
      action: "escalated",
    });

    expect((await timeline()).entries).toEqual([]);
    expect((await person()).accounts[0]?.latestAt).toBeNull();
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
