import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { eq } from "drizzle-orm";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import { romeAgentMessages, romeSessions } from "../db/schema.js";
import { channelChatId } from "../db/session-kind.js";
import { chatKey, placeIn } from "./place.js";
import { send } from "./send.js";

// Sending into a place. What these pin: a send names a place and goes out at
// that place's address, the message is on record before the platform is
// asked, and the platform's answer settles its delivery.

const GROUP = "tg-group-1" as ChatId;
const TOPIC = "tg-group-1:topic-9" as ChatId;

describe("send", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db, { channels: ["telegram", "webchat"] });
  });

  const rows = () =>
    testDb.db
      .select()
      .from(romeAgentMessages)
      .where(eq(romeAgentMessages.sessionId, channelChatId("telegram", TOPIC)))
      .all();

  it("sends into a thread at the thread's address, and records it in the thread", async () => {
    const result = await send(deps, placeIn(chatKey("telegram", GROUP), TOPIC), { text: "hi" });

    expect(result.ok).toBe(true);
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([
      { chatId: TOPIC, message: { text: "hi" } },
    ]);
    const thread = testDb.db
      .select()
      .from(romeSessions)
      .where(eq(romeSessions.id, channelChatId("telegram", TOPIC)))
      .get();
    expect(thread?.parentSessionId).toBe(channelChatId("telegram", GROUP));
    expect(rows()).toMatchObject([{ delivery: "sent", senderId: "rome" }]);
  });

  it("records the message as pending before the platform is asked", async () => {
    const transport = deps.transports.get("telegram")!;
    const sendOnTransport = transport.send.bind(transport);
    let seen: unknown;
    rs.spyOn(transport, "send").mockImplementation(async (...args) => {
      seen = rows().map((row) => row.delivery);
      return sendOnTransport(...args);
    });

    await send(deps, placeIn(chatKey("telegram", GROUP), TOPIC), { text: "hi" });

    expect(seen).toEqual(["pending"]);
  });

  it("keeps a refused message as failed, in the platform's words", async () => {
    rs.spyOn(deps.transports.get("telegram")!, "send").mockRejectedValue(
      new Error("chat not found"),
    );

    const result = await send(deps, placeIn(chatKey("telegram", GROUP), TOPIC), { text: "hi" });

    expect(result).toEqual({ ok: false, error: "chat not found" });
    expect(rows()).toMatchObject([{ delivery: "failed", deliveryError: "chat not found" }]);
  });

  it("refuses a sender Rome does not hold, before asking the platform", async () => {
    const result = await send(
      deps,
      placeIn(chatKey("telegram", GROUP)),
      { text: "hi" },
      {
        platform: "telegram",
        id: "not-rome",
      },
    );

    expect(result).toMatchObject({ ok: false, invalid: expect.any(String) });
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([]);
  });

  describe("into a dashboard chat", () => {
    const DASHBOARD_CHAT = placeIn(chatKey("webchat", "chat-1" as ChatId));
    const CONCIERGE = { platform: "webchat", id: "core:concierge" };
    const inbox = () => ({
      post: rs.fn(async () => ({ ok: true as const, messageId: "input-1", at: new Date(0) })),
    });

    it("posts it to the dashboard as the agent account it names, and never to the channel", async () => {
      const dashboard = inbox();
      const result = await send({ ...deps, dashboard }, DASHBOARD_CHAT, { text: "hi" }, CONCIERGE);

      expect(result).toEqual({ ok: true, sent: { ref: "chat-1:input-1", timestamp: 0 } });
      expect(dashboard.post).toHaveBeenCalledWith("chat-1", { text: "hi" }, CONCIERGE);
      expect(deps.transports.get("webchat")?.sentMessages).toEqual([]);
      expect(testDb.db.select().from(romeAgentMessages).all()).toEqual([]);
    });

    it("answers the dashboard's refusal in its words", async () => {
      const dashboard = {
        post: async () => ({ ok: false as const, error: "This chat is archived and read-only" }),
      };
      const result = await send({ ...deps, dashboard }, DASHBOARD_CHAT, { text: "hi" }, CONCIERGE);

      expect(result).toEqual({ ok: false, error: "This chat is archived and read-only" });
    });

    it("refuses a send that names no dashboard account, or a thread", async () => {
      const dashboard = inbox();
      const unnamed = await send({ ...deps, dashboard }, DASHBOARD_CHAT, { text: "hi" });
      const elsewhere = await send(
        { ...deps, dashboard },
        DASHBOARD_CHAT,
        { text: "hi" },
        {
          platform: "telegram",
          id: "rome-bot",
        },
      );
      const threaded = await send(
        { ...deps, dashboard },
        placeIn(chatKey("webchat", "chat-1" as ChatId), "t-1" as ChatId),
        { text: "hi" },
        CONCIERGE,
      );

      expect([unnamed, elsewhere, threaded].map((result) => "invalid" in result)).toEqual([
        true,
        true,
        true,
      ]);
      expect(dashboard.post).not.toHaveBeenCalled();
    });

    it("refuses it where no dashboard takes sends", async () => {
      const result = await send(deps, DASHBOARD_CHAT, { text: "hi" }, CONCIERGE);

      expect(result).toEqual({ ok: false, send: "unsupported" });
      expect(deps.transports.get("webchat")?.sentMessages).toEqual([]);
    });
  });

  it("refuses a place on a platform Rome holds no account on", async () => {
    const result = await send(deps, placeIn(chatKey("discord", "d-1" as ChatId)), { text: "hi" });

    expect(result).toEqual({ ok: false, send: "not-connected" });
  });
});
