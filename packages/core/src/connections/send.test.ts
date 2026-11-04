import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import { romeAgentMessages } from "../db/schema.js";
import { chatKey, placeIn } from "../chats/place.js";
import { send } from "./send.js";

// Sending into a place. What these pin: a send names a place and goes out at
// that place's address, and the platform's answer is the message's delivery.

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

  /** What Chats holds as said, with the chat it was said in. */
  const lines = () =>
    testDb.db.all<{
      key: string;
      platform: string;
      chat: string;
      kind: string;
      thread: string | null;
      account: string;
      agent: string | null;
      text: string;
    }>(sql`
      SELECT m.key, c.platform, c.key AS chat, c.kind, m.thread_id AS thread,
        m.sender_account_id AS account, m.sender_agent AS agent, m.text
      FROM chat_messages m JOIN chats c ON c.id = m.chat_id
    `);

  it("sends into a thread at the thread's address, and records it in the thread", async () => {
    const result = await send(deps, placeIn(chatKey("telegram", GROUP), TOPIC), { text: "hi" });

    expect(result).toMatchObject({ ok: true, delivery: { state: "sent" } });
    expect(deps.transports.get("telegram")?.sentMessages).toEqual([
      { chatId: TOPIC, message: { text: "hi" } },
    ]);
    expect(lines()).toMatchObject([
      {
        platform: "telegram",
        chat: GROUP,
        kind: "group",
        thread: TOPIC,
        agent: "main",
        text: "hi",
      },
    ]);
    // Chats holds it, not the legacy transcript.
    expect(testDb.db.select().from(romeAgentMessages).all()).toEqual([]);
  });

  it("records a send to a direct message in the direct message", async () => {
    const result = await send(deps, placeIn(chatKey("telegram", "42" as ChatId)), { text: "hi" });

    expect(result).toMatchObject({ ok: true });
    expect(lines()).toMatchObject([{ kind: "dm", thread: null, text: "hi" }]);
  });

  it("goes out unrecorded when nothing records sends", async () => {
    const { recording: _unused, ...unrecorded } = deps;
    const result = await send(unrecorded, placeIn(chatKey("telegram", GROUP)), { text: "hi" });

    expect(result).toMatchObject({ ok: true });
    expect(deps.transports.get("telegram")?.sentMessages).toHaveLength(1);
    expect(lines()).toEqual([]);
  });

  it("answers a refused message as failed, in the platform's words, and records nothing", async () => {
    rs.spyOn(deps.transports.get("telegram")!, "send").mockRejectedValue(
      new Error("chat not found"),
    );

    const result = await send(deps, placeIn(chatKey("telegram", GROUP), TOPIC), { text: "hi" });

    expect(result).toMatchObject({
      ok: false,
      error: "chat not found",
      delivery: { state: "failed", error: "chat not found" },
    });
    expect(lines()).toEqual([]);
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

      expect(result).toEqual({
        ok: true,
        sent: { ref: "chat-1:input-1", timestamp: 0 },
        delivery: { state: "sent", at: new Date(0) },
      });
      expect(dashboard.post).toHaveBeenCalledWith("chat-1", { text: "hi" }, CONCIERGE);
      expect(deps.transports.get("webchat")?.sentMessages).toEqual([]);
      expect(lines()).toEqual([]);
    });

    it("answers the dashboard's refusal in its words", async () => {
      const dashboard = {
        post: async () => ({ ok: false as const, error: "This chat is archived and read-only" }),
      };
      const result = await send({ ...deps, dashboard }, DASHBOARD_CHAT, { text: "hi" }, CONCIERGE);

      expect(result).toMatchObject({
        ok: false,
        error: "This chat is archived and read-only",
        delivery: { state: "failed", error: "This chat is archived and read-only" },
      });
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
      const byChannel = await send(
        { ...deps, dashboard },
        DASHBOARD_CHAT,
        { text: "hi" },
        {
          channel: "webchat",
        },
      );
      const threaded = await send(
        { ...deps, dashboard },
        placeIn(chatKey("webchat", "chat-1" as ChatId), "t-1" as ChatId),
        { text: "hi" },
        CONCIERGE,
      );

      expect(
        [unnamed, elsewhere, byChannel, threaded].map((result) => "invalid" in result),
      ).toEqual([true, true, true, true]);
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
