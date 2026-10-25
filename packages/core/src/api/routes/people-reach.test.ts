import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import type { OutboxPage, PersonResource, TimelinePage } from "@rome/api-types/people";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { peopleRoutes } from "./people.js";

// A link names an account on a platform, and every one of Rome's accounts on
// that platform reaches it (docs/domains/people.md#account). The bot and the
// signed-in account here are two of Rome's accounts on Telegram: Mei is linked
// through the bot, and her conversation lives on the signed-in account.

const TG = "4242";

const textContent = (text: string) => JSON.stringify([{ type: "text", content: text }]);

describe("People read through every one of Rome's accounts on a platform", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;
  let personId: string;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db, { channels: ["telegram", "telegram_user", "webchat"] });
    app = new Hono().route("/", peopleRoutes(deps));
    personId = await deps.personMappingRepo.create({
      displayName: "Mei",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram", channelUserId: TG }],
    });

    const conversation = await deps.webchatRepo.ensureChannelChat({
      channel: "telegram_user",
      threadId: TG,
      threadType: "private",
      agentName: "main",
    });
    await deps.webchatRepo.addConversationMessage({
      sessionId: conversation.id,
      role: "user",
      content: textContent("from the other account"),
      platformMessageId: "tgu-1",
      senderId: TG,
      senderName: "Mei",
      createdAt: new Date("2026-08-03T08:00:00Z"),
    });
  });
  afterEach(() => testDb.close());

  it("reads history from another of Rome's accounts on the platform", async () => {
    const page = (await (await app.request(`/people/${personId}/messages`)).json()) as TimelinePage;

    expect(page.entries.map((entry) => entry.body)).toEqual(["from the other account"]);
  });

  it("narrows to a link's channel with the platform's whole history", async () => {
    const page = (await (
      await app.request(`/people/${personId}/messages?channel=telegram`)
    ).json()) as TimelinePage;

    expect(page.entries).toHaveLength(1);
  });

  it("reads one account's own history when the page names its address", async () => {
    // A second account of Mei's on the platform, under another id. Both
    // accounts are read through both channels, and only the server, which
    // reads by address, can tell their histories apart.
    await deps.personMappingRepo.addChannelMapping(personId, "telegram_user", "999");

    const read = async (channel: string, channelUserId: string) =>
      (
        (await (
          await app.request(
            `/people/${personId}/messages?channel=${channel}&channelUserId=${channelUserId}`,
          )
        ).json()) as TimelinePage
      ).entries.map((entry) => entry.body);

    expect(await read("telegram", TG)).toEqual(["from the other account"]);
    expect(await read("telegram_user", "999")).toEqual([]);
    expect(await read("telegram", "not-theirs")).toEqual([]);
  });

  it("dates the link by its latest message on any of the platform's accounts", async () => {
    const person = (await (await app.request(`/people/${personId}`)).json()) as PersonResource;

    expect(person.accounts[0]?.latestAt).not.toBeNull();
  });

  it("still sends from the account the link names", async () => {
    const res = await app.request(`/people/${personId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "telegram", channelUserId: TG, text: "hi" }),
    });

    expect(res.status).toBe(202);
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
    expect(deps.transports.get("telegram_user")?.sentMessages).toEqual([]);
  });

  it("shows, retries and discards a failed send from any of the platform's accounts", async () => {
    // A send that failed while Mei was linked through the signed-in account,
    // before the link moved to the bot's channel.
    const open = async () => {
      const row = await deps.outboxRepo.open({
        channel: "telegram_user",
        channelUserId: TG,
        chatId: TG,
        text: "hi",
      });
      await deps.outboxRepo.refused(row.id, "down");
      return row.id;
    };
    const retryId = await open();
    const discardId = await open();

    const outbox = (await (await app.request(`/people/${personId}/outbox`)).json()) as OutboxPage;
    expect(outbox.messages).toHaveLength(2);

    const retried = await app.request(`/people/${personId}/outbox/${retryId}/retry`, {
      method: "POST",
    });
    const discarded = await app.request(`/people/${personId}/outbox/${discardId}`, {
      method: "DELETE",
    });

    expect(retried.status).toBe(202);
    expect(discarded.status).toBe(204);
  });

  it("leaves out an address on the platform that another person holds", async () => {
    // Links are still keyed by connection kind, so another person can hold
    // the same id through the signed-in account.
    const otherId = await deps.personMappingRepo.create({
      displayName: "Bo",
      bondLevel: "acquaintance",
      approved: true,
      channelMappings: [{ channel: "telegram_user", channelUserId: TG }],
    });
    const row = await deps.outboxRepo.open({
      channel: "telegram_user",
      channelUserId: TG,
      chatId: TG,
      text: "for Bo",
    });
    await deps.outboxRepo.refused(row.id, "down");

    const page = (await (await app.request(`/people/${personId}/messages`)).json()) as TimelinePage;
    const outbox = (await (await app.request(`/people/${personId}/outbox`)).json()) as OutboxPage;
    const discarded = await app.request(`/people/${personId}/outbox/${row.id}`, {
      method: "DELETE",
    });
    const theirs = (await (
      await app.request(`/people/${otherId}/messages`)
    ).json()) as TimelinePage;

    expect(page.entries).toEqual([]);
    expect(outbox.messages).toEqual([]);
    expect(discarded.status).toBe(404);
    expect(theirs.entries).toHaveLength(1);
  });

  it("keeps reading an account of Rome's that is no longer connected", async () => {
    // A restart drops a disconnected channel from the live list, and its
    // record and Rome's transcript of it stay.
    const disconnected = new Hono().route(
      "/",
      peopleRoutes({
        ...deps,
        channels: deps.channels.filter((channel) => channel.name !== "telegram_user"),
        recordedChannels: () => ["telegram", "telegram_user"],
      }),
    );

    const page = (await (
      await disconnected.request(`/people/${personId}/messages`)
    ).json()) as TimelinePage;

    expect(page.entries.map((entry) => entry.body)).toEqual(["from the other account"]);
  });
});
