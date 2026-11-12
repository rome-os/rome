import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { backfillLegacyChats } from "../../db/chats-backfill.js";
import { TurnLinks } from "../../sessions/turn-links.js";
import { buildAgent, createTestDb, type TestDb } from "../../test/helpers.js";
import { ChatsWebChatRepository } from "../../webchat/chats-webchat-repository.js";
import { WebChatRepository } from "../../webchat/repository.js";
import { resolveChatSenders } from "./chat-senders.js";
import { resolveReply } from "./webchat-reply.js";

const text = (content: string) => JSON.stringify([{ type: "text", content }]);

describe("resolveChatSenders and resolveReply", () => {
  let testDb: TestDb;
  let repo: ChatsWebChatRepository;
  let links: TurnLinks;

  beforeEach(() => {
    testDb = createTestDb();
    links = new TurnLinks(testDb.db);
    repo = new ChatsWebChatRepository(testDb.db, { links });
  });
  afterEach(() => testDb.close());

  it("keeps legacy Concierge attribution and human identities through startup backfill", async () => {
    const legacy = new WebChatRepository(testDb.db);
    await legacy.createSession("old-chat", "Before the switch");
    const guardian = { kind: "guardian" as const, userId: "seat", via: "cookie" as const };
    await legacy.recordUserInput("old-concierge", "old-chat", text("Find flights"), guardian, {
      platform: "webchat",
      id: "core:concierge",
    });
    await legacy.recordUserInput("old-loopback", "old-chat", text("Loopback"), {
      ...guardian,
      via: "loopback",
    });
    await legacy.recordUserInput("old-cookie", "old-chat", text("Typed"), guardian);
    await legacy.recordUserInput("old-visitor", "old-chat", text("Visitor"), {
      kind: "visitor",
      accountId: "alex",
      email: "alex@example.com",
    });
    backfillLegacyChats(testDb.db);
    const deps = {
      db: testDb.db,
      // No agent name set: the Concierge goes by the main agent's default name.
      settingsRepo: { get: async (key: string) => (key === "agentName" ? null : "Ray") },
      agentLoader: { list: () => [buildAgent("core:concierge")] },
      appCatalog: { get: () => undefined },
    } as never;
    const sources = await repo.getUserMessageSources("old-chat");
    expect(sources).toEqual(new Map([["old-concierge", "core:concierge"]]));
    const senders = await resolveChatSenders(
      deps,
      await repo.getUserMessageActors("old-chat"),
      sources,
    );
    expect(senders.get("old-concierge")).toMatchObject({ kind: "automated", name: "Rome" });
    expect(senders.get("old-concierge")).not.toHaveProperty("onBehalfOf");
    expect(senders.get("old-loopback")).toMatchObject({ kind: "guardian", name: "Ray" });
    expect(senders.get("old-cookie")).toMatchObject({ kind: "guardian", name: "Ray" });
    expect(senders.get("old-visitor")).toMatchObject({
      kind: "visitor",
      name: "alex@example.com",
      accountId: "alex",
    });
    expect(await repo.getReplyTarget("old-chat", "old-concierge")).not.toBeNull();
    const page = await repo.getMessagesPage("old-chat", { limit: 10 });
    expect(page.rows.map((message) => message.id).sort()).toEqual([
      "old-concierge",
      "old-cookie",
      "old-loopback",
      "old-visitor",
    ]);
  });

  it.each([
    "cookie",
    "loopback",
  ] as const)("reads a Concierge input speaking for the guardian via %s", async (via) => {
    await repo.createSession("concierge-source", "Concierge");
    const actor = { kind: "guardian" as const, userId: "seat", via };
    await repo.recordUserInput("concierge-input", "concierge-source", "[]", actor, {
      platform: "webchat",
      id: "core:concierge",
    });
    const target = await repo.getReplyTarget("concierge-source", "concierge-input");
    expect(target?.senderId).toBe("core:concierge");
    expect(target?.actor?.kind).toBe("guardian");
    expect((await repo.getUserMessageActors("concierge-source")).get("concierge-input")?.kind).toBe(
      "guardian",
    );
    expect(await repo.getUserMessageSources("concierge-source")).toEqual(
      new Map([["concierge-input", "core:concierge"]]),
    );
    const deps = {
      db: testDb.db,
      webchatRepo: repo,
      settingsRepo: { get: async (key: string) => (key === "agentName" ? "Milo" : "Ray") },
      agentLoader: { list: () => [buildAgent("core:concierge")] },
      appCatalog: { get: () => undefined },
    } as never;
    const senders = await resolveChatSenders(
      deps,
      await repo.getUserMessageActors("concierge-source"),
      await repo.getUserMessageSources("concierge-source"),
    );
    expect(senders.get("concierge-input")).toMatchObject({
      kind: "automated",
      name: "Milo",
      onBehalfOf: { kind: "guardian", name: "Ray" },
    });
    await repo.recordUserInput(
      "concierge-quote",
      "concierge-source",
      JSON.stringify([{ type: "text", content: "Status?" }]),
      actor,
      { platform: "webchat", id: "core:concierge" },
    );
    const quote = await resolveReply(deps, {
      sessionId: "concierge-source",
      messageId: "concierge-quote",
      ownRowOnly: true,
    });
    expect(quote).toMatchObject({ ok: true, part: { author: "automated", name: "Milo" } });
    if (quote.ok) expect(quote.promptLine).toContain("Milo: Status?");
  });
});
