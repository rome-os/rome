import { describe, it, expect, beforeEach, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { sql } from "drizzle-orm";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../test/helpers.js";
import { seedBaseline } from "../test/seeds.js";
import { chatKey, placeIn } from "../chats/place.js";
import { send } from "../chats/send.js";
import { ownPlatforms } from "./send.js";

// The dashboard's side of Chats' send. What these pin: a send into a dashboard
// chat posts to the dashboard as the agent account it names, and never goes
// out on a connected account's channel.

describe("a send into a dashboard chat", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    await seedBaseline(testDb.db);
    deps = await buildTestDeps(testDb.db, { channels: ["telegram", "webchat"] });
  });

  /** What Chats holds as said. */
  const lines = () => testDb.db.all<{ text: string }>(sql`SELECT text FROM chat_messages`);

  const DASHBOARD_CHAT = placeIn(chatKey("webchat", "chat-1" as ChatId));
  const CONCIERGE = { platform: "webchat", id: "core:concierge" };
  const inbox = () => ({
    post: rs.fn(async () => ({ ok: true as const, messageId: "input-1", at: new Date(0) })),
  });

  it("posts it to the dashboard as the agent account it names, and never to the channel", async () => {
    const dashboard = inbox();
    const result = await send(
      { ...deps, ownPlatforms: ownPlatforms(dashboard) },
      DASHBOARD_CHAT,
      { text: "hi" },
      CONCIERGE,
    );

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
    const result = await send(
      { ...deps, ownPlatforms: ownPlatforms(dashboard) },
      DASHBOARD_CHAT,
      { text: "hi" },
      CONCIERGE,
    );

    expect(result).toMatchObject({
      ok: false,
      error: "This chat is archived and read-only",
      delivery: { state: "failed", error: "This chat is archived and read-only" },
    });
  });

  it("refuses a send that names no dashboard account, or a thread", async () => {
    const dashboard = inbox();
    const unnamed = await send({ ...deps, ownPlatforms: ownPlatforms(dashboard) }, DASHBOARD_CHAT, {
      text: "hi",
    });
    const elsewhere = await send(
      { ...deps, ownPlatforms: ownPlatforms(dashboard) },
      DASHBOARD_CHAT,
      { text: "hi" },
      {
        platform: "telegram",
        id: "rome-bot",
      },
    );
    const byChannel = await send(
      { ...deps, ownPlatforms: ownPlatforms(dashboard) },
      DASHBOARD_CHAT,
      { text: "hi" },
      {
        channel: "webchat",
      },
    );
    const threaded = await send(
      { ...deps, ownPlatforms: ownPlatforms(dashboard) },
      placeIn(chatKey("webchat", "chat-1" as ChatId), "t-1" as ChatId),
      { text: "hi" },
      CONCIERGE,
    );

    expect([unnamed, elsewhere, byChannel, threaded].map((result) => "invalid" in result)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(dashboard.post).not.toHaveBeenCalled();
  });

  it("refuses it where no dashboard takes sends", async () => {
    const result = await send(
      { ...deps, ownPlatforms: ownPlatforms() },
      DASHBOARD_CHAT,
      { text: "hi" },
      CONCIERGE,
    );

    expect(result).toEqual({ ok: false, send: "unsupported" });
    expect(deps.transports.get("webchat")?.sentMessages).toEqual([]);
  });
});
