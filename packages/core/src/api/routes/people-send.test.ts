import { describe, it, expect, beforeEach } from "@rstest/core";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type {
  LinkedAccount,
  OutboxMessage,
  OutboxPage,
  PersonResource,
  SendRefusal,
  TimelinePage,
} from "@rome/api-types/people";
import { peopleRoutes } from "./people.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";

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

    expect(deps.channelPortMap.get("telegram")?.sentMessages).toEqual([
      { channelUserId: TG, threadId: TG, message: { text: "on my way" } },
    ]);
  });

  it("refuses an account the person does not hold", async () => {
    const res = await send({ channel: "telegram", channelUserId: OTHER_TG, text: "hello" });

    // Not a 404 and not a silent redirect to an account they do hold: the
    // guardian addressed someone, and delivering to anyone else is worse than
    // refusing.
    expect(res.status).toBe(400);
    expect(deps.channelPortMap.get("telegram")?.sentMessages).toEqual([]);
  });

  it("refuses a channel that does not do direct messaging, naming the state", async () => {
    // A talker with no `directMessaging` feature is exactly LinkedIn: it
    // mirrors an inbox it cannot write to, and says so rather than throwing
    // when someone tries.
    const readOnly = { ...deps, talkRouter: { ...deps.talkRouter, feature: () => null } };
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

  it("keeps a refused send in the outbox, and retries it under its own id", async () => {
    const adapter = deps.channelPortMap.get("telegram")!;
    adapter.sendMessage = async () => {
      throw new Error("provider rejected");
    };

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
    adapter.sendMessage = async (channelUserId, threadId, message) => {
      adapter.sentMessages.push({ channelUserId, threadId, message });
    };
    const retried = await app.request(`/people/${personId}/outbox/${failed!.id}/retry`, {
      method: "POST",
    });
    expect(retried.status).toBe(202);
    expect(((await retried.json()) as OutboxMessage).id).toBe(failed!.id);
    expect(await outbox()).toEqual([]);
    expect((await timeline()).entries.map((entry) => entry.body)).toContain("will fail");
  });

  it("discards a failed send when the guardian gives up on it", async () => {
    deps.channelPortMap.get("telegram")!.sendMessage = async () => {
      throw new Error("nope");
    };
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
      conversationId: LID,
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
    deps.channelPortMap.get("telegram")!.sendMessage = async () => {
      throw new Error("nope");
    };
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

  it("will not discard a send that is still in flight", async () => {
    const row = await deps.outboxRepo.open({
      channel: "whatsapp",
      channelUserId: LID,
      conversationId: LID,
      text: "still going",
    });
    // Dropping this row would leave the guardian with no account of a message
    // that may yet arrive.
    const res = await app.request(`/people/${personId}/outbox/${row.id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await outbox()).toHaveLength(1);
  });
});
