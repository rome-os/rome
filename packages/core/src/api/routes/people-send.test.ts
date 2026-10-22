import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import type {
  LinkedAccount,
  OutboxMessage,
  OutboxPage,
  PersonResource,
  SendRefusal,
  TimelinePage,
} from "@rome/api-types/people";
import { peopleRoutes } from "./people.js";
import {
  createTestConnections,
  createTestDb,
  buildTestDeps,
  testChannels,
  type TestDb,
  type TestDeps,
} from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import { OutboxRepository } from "../../db/repositories/outbox.js";
import {
  channels as channelRows,
  outboundSendReceipts,
  romeAgentMessages,
  romeSessions,
} from "../../db/schema.js";
import { channelList } from "../../channels/channel-list.js";
import { channelChatId } from "../../db/session-kind.js";
import { conversationPlatformMessageId } from "../../db/repositories/webchat.js";
import { SEND_IDEMPOTENCY_RETENTION_MS } from "@rome/api-types/people";

// Sending to a person, and the outbox a send lives in until it arrives.
//
// What these pin is the pair of rules the surface rests on: a send names the
// account it is for and Rome never chooses one, and a row leaves the outbox by
// being observed on the timeline rather than by anything remembering to clear
// it.

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

    personId = await deps.personMappingRepo.create({
      displayName: "Send Target",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: TG }],
    });
  });

  const send = (body: unknown, id = personId) =>
    app.request(`/people/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const outbox = async (id = personId): Promise<OutboxMessage[]> => {
    const res = await app.request(`/people/${id}/outbox`);
    return ((await res.json()) as OutboxPage).messages;
  };

  const timeline = async (id = personId): Promise<TimelinePage> => {
    const res = await app.request(`/people/${id}/messages`);
    return (await res.json()) as TimelinePage;
  };

  const accountOf = async (channel: string): Promise<LinkedAccount> => {
    const res = await app.request(`/people/${personId}`);
    const person = (await res.json()) as PersonResource;
    return person.accounts.find((account) => account.channel === channel)!;
  };

  it("sends to the account the request names, and answers the row it became", async () => {
    const res = await send({ channel: "telegram", channelUserId: TG, text: "on my way" });

    // 202: the channel took it. Whether it arrived is a different question and
    // the outbox is where it is asked.
    expect(res.status).toBe(202);
    const message = (await res.json()) as OutboxMessage;
    expect(message).toMatchObject({
      channel: "telegram",
      channelUserId: TG,
      text: "on my way",
      state: "unconfirmed",
    });

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

  it("claims a client send id once across concurrent requests", async () => {
    const body = { id: crypto.randomUUID(), channel: "telegram", channelUserId: TG, text: "hello" };
    const responses = await Promise.all([send(body), send(body)]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    for (const response of responses) {
      expect(await response.json()).toMatchObject({ id: body.id, text: "hello" });
    }
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
    expect((await send(body)).status).toBe(202);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
  });

  it("delivers identical messages when they have distinct send ids", async () => {
    const body = { channel: "telegram", channelUserId: TG, text: "ok" };
    const responses = await Promise.all([
      send({ ...body, id: crypto.randomUUID() }),
      send({ ...body, id: crypto.randomUUID() }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(2);
  });

  it("refuses reuse of a send id for different text or another account", async () => {
    const body = { id: crypto.randomUUID(), channel: "telegram", channelUserId: TG, text: "hello" };
    expect((await send(body)).status).toBe(202);
    expect((await send({ ...body, text: "different" })).status).toBe(409);
    const anotherPerson = await deps.personMappingRepo.create({
      displayName: "Another target",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: OTHER_TG }],
    });
    expect((await send({ ...body, channelUserId: OTHER_TG }, anotherPerson)).status).toBe(409);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
  });

  it("validates a supplied send id before contacting the provider", async () => {
    for (const id of [null, 7, "", "not-a-uuid"]) {
      expect(
        (await send({ id, channel: "telegram", channelUserId: TG, text: "hello" })).status,
      ).toBe(400);
    }
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

  it("clears the outbox row once the message is on the timeline", async () => {
    await send({ channel: "telegram", channelUserId: TG, text: "landed" });

    // Telegram keeps no mirror of its own, so Rome's transcript of the send is
    // what the timeline reads — and the row is on it immediately.
    const entries = (await timeline()).entries;
    expect(entries.map((entry) => entry.body)).toContain("landed");
    expect(entries[0]?.direction).toBe("outbound");

    // Nothing was told the send had arrived. The read noticed.
    expect(await outbox()).toEqual([]);
  });

  it("replays a delivered send after outbox cleanup and repository recreation", async () => {
    const body = {
      id: crypto.randomUUID(),
      channel: "telegram",
      channelUserId: TG,
      text: "landed once",
    };
    const response = await send(body);
    const original = await response.json();
    const row = (await deps.outboxRepo.find(body.id))!;
    expect(await outbox()).toEqual([]);
    expect(await deps.outboxRepo.find(body.id)).toBeNull();

    deps.outboxRepo = new OutboxRepository(testDb.db);
    app = new Hono().route("/", peopleRoutes(deps));
    const replayed = await send(body);
    expect(replayed.status).toBe(202);
    expect(await replayed.json()).toEqual(original);
    expect(await deps.outboxRepo.openOnce({ ...body, chatId: row.chatId })).toEqual({
      created: false,
      message: original,
    });
    expect(await deps.outboxRepo.find(body.id)).toBeNull();
    expect(await outbox()).toEqual([]);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
    expect((await timeline()).entries.filter((entry) => entry.body === body.text)).toHaveLength(1);
    expect((await send({ ...body, text: "different message" })).status).toBe(409);
  });

  it("retains a receipt for 24 hours after cleanup, then permits a new send", async () => {
    rs.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.now();
    rs.setSystemTime(startedAt);
    const body = {
      id: crypto.randomUUID(),
      channel: "telegram",
      channelUserId: TG,
      text: "receipt expiry",
    };
    const original = await (await send(body)).json();
    const removedAt = startedAt + 10_000;
    rs.setSystemTime(removedAt);
    expect(await outbox()).toEqual([]);

    rs.setSystemTime(removedAt + SEND_IDEMPOTENCY_RETENTION_MS - 1);
    expect(await (await send(body)).json()).toEqual(original);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);

    rs.setSystemTime(removedAt + SEND_IDEMPOTENCY_RETENTION_MS);
    expect(await deps.outboxRepo.findSend(body.id)).toBeNull();
    expect((await send(body)).status).toBe(202);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(2);
  });

  it("retains a discarded send's response without retrying the provider", async () => {
    const provider = rs
      .spyOn(deps.transports.get("telegram")!, "send")
      .mockRejectedValue(new Error("refused"));
    const body = {
      id: crypto.randomUUID(),
      channel: "telegram",
      channelUserId: TG,
      text: "discarded",
    };
    const original = await (await send(body)).json();
    const discarded = await app.request(`/people/${personId}/outbox/${body.id}`, {
      method: "DELETE",
    });
    expect(discarded.status).toBe(204);
    expect(await deps.outboxRepo.find(body.id)).toBeNull();
    // The replay is the same send, except that its row is gone and so is
    // anything to discard.
    expect(original).toMatchObject({ state: "failed", dismissable: true });
    expect(await (await send(body)).json()).toEqual({ ...original, dismissable: false });
    expect(await outbox()).toEqual([]);
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("replays a receipt written before rows carried dismissable as not dismissable", async () => {
    const id = crypto.randomUUID();
    const { dismissable: _, ...legacy } = {
      id,
      channel: "telegram",
      channelUserId: TG,
      text: "sent last release",
      timestamp: Math.floor(Date.now() / 1000),
      state: "unconfirmed",
      ref: null,
      error: null,
      dismissable: false,
    } satisfies OutboxMessage;
    await testDb.db.insert(outboundSendReceipts).values({
      id,
      response: legacy as OutboxMessage,
      expiresAt: new Date(Date.now() + SEND_IDEMPOTENCY_RETENTION_MS),
    });

    const replayed = await send({ id, channel: "telegram", channelUserId: TG, text: legacy.text });
    expect(await replayed.json()).toEqual({ ...legacy, dismissable: false });
  });

  it("keeps a refused send in the outbox, and retries it under its own id", async () => {
    const refused = rs
      .spyOn(deps.transports.get("telegram")!, "send")
      .mockRejectedValue(new Error("provider rejected"));

    await send({ channel: "telegram", channelUserId: TG, text: "will fail" });

    // Durable, unlike the first design where a failed send existed only in
    // whatever the client held in memory.
    const [failed] = await outbox();
    expect(failed).toMatchObject({
      state: "failed",
      error: "provider rejected",
      text: "will fail",
    });
    expect((await timeline()).entries.map((entry) => entry.body)).not.toContain("will fail");

    // The retry succeeds and reuses the row, so the conversation does not grow
    // a second message the guardian never wrote.
    refused.mockRestore();
    const retried = await app.request(`/people/${personId}/outbox/${failed!.id}/retry`, {
      method: "POST",
    });
    expect(retried.status).toBe(202);
    expect(((await retried.json()) as OutboxMessage).id).toBe(failed!.id);
    expect(await outbox()).toEqual([]);
    expect((await timeline()).entries.map((entry) => entry.body)).toContain("will fail");
  });

  it("discards a failed send when the guardian gives up on it", async () => {
    rs.spyOn(deps.transports.get("telegram")!, "send").mockRejectedValue(new Error("nope"));
    await send({ channel: "telegram", channelUserId: TG, text: "abandon me" });
    const [failed] = await outbox();

    const res = await app.request(`/people/${personId}/outbox/${failed!.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(await outbox()).toEqual([]);
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

// Regressions found in review of #208. Each one is a way the outbox could
// disagree with what actually happened to a message.
describe("People send API — delivery bookkeeping", () => {
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
    personId = await deps.personMappingRepo.create({
      displayName: "Folded Contact",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "whatsapp", channelUserId: LID }],
    });
  });

  const outbox = async (): Promise<OutboxMessage[]> => {
    const res = await app.request(`/people/${personId}/outbox`);
    return ((await res.json()) as OutboxPage).messages;
  };

  it("clears a row whose echo lands under the account's other address", async () => {
    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", channelUserId: LID, text: "sent to the lid" }),
    });
    expect(res.status).toBe(202);
    const sent = (await res.json()) as OutboxMessage;
    const providerId = sent.ref!.split(":").pop()!;

    // WhatsApp echoes Rome's own message back, and the chat it hangs off is the
    // phone JID rather than the LID the send named. Predicting only the address
    // sent to would leave this row waiting on a ref that never appears.
    await deps.whatsAppStoreRepo.upsertMessages([
      {
        id: providerId,
        chatJid: PN,
        senderJid: PN,
        fromMe: true,
        timestamp: new Date(),
        type: "text",
        text: "sent to the lid",
        hasMedia: false,
      },
    ]);

    expect(await outbox()).toEqual([]);
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

    expect(res.status).toBe(202);
    expect((await res.json()) as OutboxMessage).toMatchObject({ state: "unconfirmed" });
    expect((await outbox())[0]).toMatchObject({ state: "unconfirmed" });
  });

  it("recovers a send whose process died before the channel answered", async () => {
    const row = await deps.outboxRepo.open({
      channel: "whatsapp",
      channelUserId: LID,
      chatId: LID,
      text: "stranded",
    });
    // Older than the window a send is given to answer in.
    testDb.db.run(
      sql`UPDATE outbound_messages SET updated_at = ${Math.floor(Date.now() / 1000) - 3600} WHERE id = ${row.id}`,
    );

    // Not cleared — the message may well have gone out — but no longer stuck:
    // it says what happened and can be tried again.
    const [recovered] = await outbox();
    expect(recovered).toMatchObject({ id: row.id, state: "failed" });
    expect(recovered!.error).toMatch(/may or may not have been sent/);

    const retried = await app.request(`/people/${personId}/outbox/${row.id}/retry`, {
      method: "POST",
    });
    expect(retried.status).toBe(202);
  });

  it("will not retry or discard a row belonging to somebody else", async () => {
    const otherId = await deps.personMappingRepo.create({
      displayName: "Somebody Else",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-elsewhere" }],
    });
    rs.spyOn(deps.transports.get("telegram")!, "send").mockRejectedValue(new Error("nope"));
    await app.request(`/people/${otherId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        channelUserId: "tg-elsewhere",
        text: "theirs",
      }),
    });
    const res = await app.request(`/people/${otherId}/outbox`);
    const [theirs] = ((await res.json()) as OutboxPage).messages;

    // A message id is not a capability. The person in the path owns the outbox
    // the request is addressing.
    expect(
      (await app.request(`/people/${personId}/outbox/${theirs!.id}/retry`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/people/${personId}/outbox/${theirs!.id}`, { method: "DELETE" })).status,
    ).toBe(404);

    const still = await app.request(`/people/${otherId}/outbox`);
    expect(((await still.json()) as OutboxPage).messages).toHaveLength(1);
  });

  it("will not discard a send while the channel has not answered", async () => {
    const row = await deps.outboxRepo.open({
      channel: "whatsapp",
      channelUserId: LID,
      chatId: LID,
      text: "still going",
    });
    // The one state where Rome does not yet know what happened. Dropping the
    // row here would lose the only record of a call that is still outstanding.
    const res = await app.request(`/people/${personId}/outbox/${row.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await outbox()).toHaveLength(1);
  });

  it("dismisses a delivered send Rome never managed to record", async () => {
    // Telegram keeps no mirror, so Rome's own transcript is how a sent message
    // reaches the timeline. If that write fails the message is delivered and
    // will never appear, and the row would otherwise be a phantom the guardian
    // can neither retry nor dismiss.
    deps.webchatRepo.recordOutboundConversationMessage = async () => {
      throw new Error("disk is full");
    };
    const tgPersonId = await deps.personMappingRepo.create({
      displayName: "Unmirrored",
      bondLevel: "other",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: "tg-unmirrored" }],
    });
    await app.request(`/people/${tgPersonId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "telegram",
        channelUserId: "tg-unmirrored",
        text: "delivered but unseen",
      }),
    });

    const listing = await app.request(`/people/${tgPersonId}/outbox`);
    const [stuck] = ((await listing.json()) as OutboxPage).messages;
    expect(stuck).toMatchObject({ state: "unconfirmed" });

    // Fresh, it is an ordinary row that usually clears itself, and dismissing
    // it would race the clearing.
    expect(
      (await app.request(`/people/${tgPersonId}/outbox/${stuck!.id}`, { method: "DELETE" })).status,
    ).toBe(404);

    // Past the window a message lands in, it is a phantom and the guardian gets
    // a way out.
    testDb.db.run(
      sql`UPDATE outbound_messages SET updated_at = ${Math.floor(Date.now() / 1000) - 3600} WHERE id = ${stuck!.id}`,
    );
    const res = await app.request(`/people/${tgPersonId}/outbox/${stuck!.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const after = await app.request(`/people/${tgPersonId}/outbox`);
    expect(((await after.json()) as OutboxPage).messages).toEqual([]);
  });

  describe("whether a row is dismissable", () => {
    afterEach(() => {
      rs.useRealTimers();
    });

    const MINUTE = 60_000;
    const startedAt = Date.UTC(2026, 0, 1);
    let tgPersonId: string;

    // Telegram keeps no mirror, and with Rome's own record failing an accepted
    // send never lands: the one case where an unconfirmed row outlives the
    // window and Discard is its way out.
    beforeEach(async () => {
      rs.useFakeTimers({ toFake: ["Date"] });
      rs.setSystemTime(startedAt);
      deps.webchatRepo.recordOutboundConversationMessage = async () => {
        throw new Error("disk is full");
      };
      tgPersonId = await deps.personMappingRepo.create({
        displayName: "Unmirrored",
        bondLevel: "other",
        approved: true,
        channelMappings: [{ channel: "telegram", channelUserId: "tg-unmirrored" }],
      });
    });

    const sendUnmirrored = (text: string) =>
      app.request(`/people/${tgPersonId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "telegram", channelUserId: "tg-unmirrored", text }),
      });
    const readRow = async (): Promise<OutboxMessage | undefined> => {
      const res = await app.request(`/people/${tgPersonId}/outbox`);
      return ((await res.json()) as OutboxPage).messages[0];
    };
    const discard = async (id: string) =>
      (await app.request(`/people/${tgPersonId}/outbox/${id}`, { method: "DELETE" })).status;

    it("measures a retried row from its retry, not its first attempt", async () => {
      const refused = rs
        .spyOn(deps.transports.get("telegram")!, "send")
        .mockRejectedValue(new Error("nope"));
      const failed = (await (await sendUnmirrored("retried")).json()) as OutboxMessage;
      expect(failed).toMatchObject({ state: "failed", dismissable: true });

      refused.mockRestore();
      rs.setSystemTime(startedAt + 4 * MINUTE);
      const retried = await app.request(`/people/${tgPersonId}/outbox/${failed.id}/retry`, {
        method: "POST",
      });
      expect(await retried.json()).toMatchObject({ state: "unconfirmed", dismissable: false });

      // Past the window counted from the first attempt, inside the one counted
      // from the retry. The row says what DELETE will answer.
      rs.setSystemTime(startedAt + 6 * MINUTE);
      expect(await readRow()).toMatchObject({ state: "unconfirmed", dismissable: false });
      expect(await discard(failed.id)).toBe(404);

      rs.setSystemTime(startedAt + 10 * MINUTE);
      expect(await readRow()).toMatchObject({ state: "unconfirmed", dismissable: true });
      expect(await discard(failed.id)).toBe(204);
    });

    it("measures an accepted row from when the channel answered", async () => {
      // A slow provider: the row is opened at the start and accepted two
      // minutes later, and the window starts at the acceptance.
      const transport = deps.transports.get("telegram")!;
      const deliver = transport.send.bind(transport);
      rs.spyOn(transport, "send").mockImplementation(async (...args) => {
        rs.setSystemTime(startedAt + 2 * MINUTE);
        return deliver(...args);
      });
      const sent = (await (await sendUnmirrored("slow channel")).json()) as OutboxMessage;
      expect(sent).toMatchObject({ state: "unconfirmed", dismissable: false });

      rs.setSystemTime(startedAt + 6 * MINUTE);
      expect(await readRow()).toMatchObject({ dismissable: false });
      expect(await discard(sent.id)).toBe(404);

      rs.setSystemTime(startedAt + 8 * MINUTE);
      expect(await readRow()).toMatchObject({ dismissable: true });
      expect(await discard(sent.id)).toBe(204);
    });

    it("never offers a send the channel has not answered", async () => {
      const row = await deps.outboxRepo.open({
        channel: "telegram",
        channelUserId: "tg-unmirrored",
        chatId: "tg-unmirrored",
        text: "still going",
      });
      rs.setSystemTime(startedAt + 4 * MINUTE);
      expect(await readRow()).toMatchObject({ id: row.id, state: "sending", dismissable: false });
      expect(await discard(row.id)).toBe(404);
    });
  });

  it("never leaves a delivered message with no record when discard races retry", async () => {
    const transport = deps.transports.get("whatsapp")!;
    const refused = rs.spyOn(transport, "send").mockRejectedValue(new Error("nope"));
    await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", channelUserId: LID, text: "contested" }),
    });
    const [failed] = await outbox();

    transport.sentMessages.length = 0;
    refused.mockRestore();

    // Whichever wins is fine. What must never happen is the discard passing a
    // `failed` check, the retry claiming the row in between, and the delete
    // then removing a row whose message is already on its way.
    await Promise.all([
      app.request(`/people/${personId}/outbox/${failed!.id}/retry`, { method: "POST" }),
      app.request(`/people/${personId}/outbox/${failed!.id}`, { method: "DELETE" }),
    ]);

    expect(transport.sentMessages.length).toBeLessThanOrEqual(1);
    if (transport.sentMessages.length === 1) {
      // Somewhere, not necessarily the outbox: a message that reached the
      // timeline has left the outbox legitimately, and that is the row doing
      // its job rather than being lost. What must never happen is a delivered
      // message the guardian can find no trace of.
      const res = await app.request(`/people/${personId}/messages`);
      const onTimeline = ((await res.json()) as { entries: { body: string | null }[] }).entries;
      const stillQueued = await outbox();
      expect(
        onTimeline.some((entry) => entry.body === "contested") || stillQueued.length === 1,
      ).toBe(true);
    }
  });

  it("sends once when a failed row is retried twice at the same moment", async () => {
    const transport = deps.transports.get("whatsapp")!;
    const refused = rs.spyOn(transport, "send").mockRejectedValue(new Error("nope"));
    await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "whatsapp", channelUserId: LID, text: "retry me once" }),
    });
    const [failed] = await outbox();

    refused.mockRestore();

    // A double-clicked Retry. Reading the state and then writing would let both
    // requests past, and the guardian's one message would arrive twice.
    const both = await Promise.all([
      app.request(`/people/${personId}/outbox/${failed!.id}/retry`, { method: "POST" }),
      app.request(`/people/${personId}/outbox/${failed!.id}/retry`, { method: "POST" }),
    ]);

    expect(both.map((r) => r.status).sort()).toEqual([202, 404]);
    expect(transport.sentMessages).toHaveLength(1);
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
        connectionId: "test:telegram",
        createdAt: new Date(0),
      })
      .run();
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

    personId = await deps.personMappingRepo.create({
      displayName: "Ada",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: OPAQUE, channelUserId: ADA }],
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

    expect(res.status).toBe(202);
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
    const outboxRes = await app.request(`/people/${personId}/outbox`);
    expect(((await outboxRes.json()) as OutboxPage).messages).toEqual([]);
  });

  // Rome never picks among a service's accounts: with a second one connected,
  // the link reaches neither, for sending or for history.
  it("reaches none of two accounts of one connection kind", async () => {
    testDb.db
      .insert(channelRows)
      .values({
        id: "tg-second",
        connectionKind: "telegram",
        platform: "telegram",
        connectionId: "test:telegram-second",
        createdAt: new Date(0),
      })
      .run();

    expect((await person()).accounts).toMatchObject([
      { channel: "telegram", channelUserId: ADA, send: "not-connected" },
    ]);
    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: ADA, text: "hi Ada" }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as SendRefusal).toMatchObject({ send: "not-connected" });
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    expect((await timeline()).entries).toEqual([]);
  });

  describe("naming the account a send goes out from", () => {
    const post = (body: Record<string, unknown>) =>
      app.request(`/people/${personId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "telegram", channelUserId: ADA, ...body }),
      });

    /** A second Telegram account, connected after the first. */
    const connectSecond = () =>
      testDb.db
        .insert(channelRows)
        .values({
          id: "tg-second",
          connectionKind: "telegram",
          platform: "telegram",
          connectionId: "test:telegram-second",
          createdAt: new Date(60_000),
        })
        .run();

    it("lists the accounts a send may go out from on the person read", async () => {
      expect((await person()).accounts[0]?.from).toEqual([OPAQUE]);
      connectSecond();
      expect((await person()).accounts[0]?.from).toEqual([OPAQUE, "tg-second"]);
    });

    it("sends from the account it names, and the outbox row records it", async () => {
      const res = await post({ text: "from the opaque account", from: OPAQUE });

      expect(res.status).toBe(202);
      const message = (await res.json()) as OutboxMessage;
      expect(message.from).toBe(OPAQUE);
      expect((await deps.outboxRepo.find(message.id))?.from).toBe(OPAQUE);
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([
        { chatId: ADA, message: { text: "from the opaque account" } },
      ]);
    });

    it("refuses an account of another connection kind, or one Rome does not hold", async () => {
      for (const from of ["webchat", "telegram", "tg-unknown"]) {
        const res = await post({ text: "hello", from });
        expect(res.status).toBe(400);
      }
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    });

    it("sends from a named account of two, and refuses a send that names none", async () => {
      connectSecond();

      expect((await post({ text: "which one?" })).status).toBe(409);
      const res = await post({ text: "from the first", from: OPAQUE });
      expect(res.status).toBe(202);
      expect(((await res.json()) as OutboxMessage).from).toBe(OPAQUE);
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([
        { chatId: ADA, message: { text: "from the first" } },
      ]);
    });

    it("replays a recorded send after the account it went out from is removed", async () => {
      const body = {
        id: "5d0c4b1e-2f3a-4e5b-9c6d-7e8f9a0b1c2d",
        text: "from the opaque account",
        from: OPAQUE,
      };
      const first = await post(body);
      expect(first.status).toBe(202);
      const sent = (await first.json()) as OutboxMessage;

      testDb.db
        .update(channelRows)
        .set({ connectionId: null })
        .where(eq(channelRows.id, OPAQUE))
        .run();
      const again = await post(body);
      expect(again.status).toBe(202);
      expect(((await again.json()) as OutboxMessage).id).toBe(sent.id);
      expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
    });

    // The link reaches the opaque account alone now, but the row went out from
    // another one, so a retry may not move it there.
    it("retries only from the account the row went out from", async () => {
      const row = await deps.outboxRepo.open({
        channel: "telegram",
        channelUserId: ADA,
        chatId: ADA,
        text: "from a removed account",
        from: "tg-second",
      });
      await deps.outboxRepo.refused(row.id, "provider down");

      const retried = await app.request(`/people/${personId}/outbox/${row.id}/retry`, {
        method: "POST",
      });
      expect(retried.status).toBe(202);
      expect((await retried.json()) as OutboxMessage).toMatchObject({
        state: "failed",
        from: "tg-second",
      });
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    });

    // A row from before the sending account was recorded went out from the
    // channel its link names. The service-named account is gone and an opaque
    // one replaced it, so a retry is refused rather than moved.
    it("retries a row from before the sender was recorded only from its own channel", async () => {
      const row = await deps.outboxRepo.open({
        channel: "telegram",
        channelUserId: ADA,
        chatId: ADA,
        text: "from the old account",
      });
      await deps.outboxRepo.refused(row.id, "provider down");

      const retried = await app.request(`/people/${personId}/outbox/${row.id}/retry`, {
        method: "POST",
      });
      expect(retried.status).toBe(202);
      expect(((await retried.json()) as OutboxMessage).state).toBe("failed");
      expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
    });

    // Two of Rome's accounts may hand out the same provider message id. A row
    // lands only on a message stored under the account it went out from.
    it("confirms a row only against the account it went out from", async () => {
      connectSecond();
      const sessionId = channelChatId(OPAQUE, ADA);
      const sentFrom = async (from: string, providerMessageId: string) => {
        const row = await deps.outboxRepo.open({
          channel: "telegram",
          channelUserId: ADA,
          chatId: ADA,
          text: `sent from ${from}`,
          from,
        });
        await deps.outboxRepo.accepted(row.id, providerMessageId);
        return row.id;
      };
      const elsewhere = await sentFrom("tg-second", "pm-shared");
      const here = await sentFrom(OPAQUE, "pm-here");
      // What the opaque account holds: a message under each provider id.
      for (const providerMessageId of ["pm-shared", "pm-here"]) {
        testDb.db
          .insert(romeAgentMessages)
          .values({
            id: conversationPlatformMessageId(sessionId, providerMessageId),
            sessionId,
            role: "notification",
            content: JSON.stringify([{ type: "text", content: providerMessageId }]),
            senderId: "rome",
            createdAt: new Date(),
          })
          .run();
      }

      const outboxRes = await app.request(`/people/${personId}/outbox`);
      const ids = ((await outboxRes.json()) as OutboxPage).messages.map((message) => message.id);
      expect(ids).toEqual([elsewhere]);
      expect(ids).not.toContain(here);
    });
  });
});
