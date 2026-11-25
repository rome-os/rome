import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { actionExecutionContext } from "../../apps/actions/context.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import { RoutinesRepository, routineChatOf } from "./routines.js";

const DAILY = {
  type: "schedule",
  localTime: "09:00",
  tzid: "UTC",
  tzMode: "fixed",
  rrule: "FREQ=DAILY",
} as const;

describe("the chat a routine works for", () => {
  let testDb: TestDb;
  let repo: RoutinesRepository;
  beforeEach(() => {
    testDb = createTestDb();
    repo = new RoutinesRepository(testDb.db);
  });
  afterEach(() => testDb.close());

  const chatOf = async (id: string) => (await repo.findById(id))?.chatId ?? null;
  const inChat = <T>(threadId: string, run: () => Promise<T>) =>
    actionExecutionContext.run(
      {
        executionId: "e1",
        rootExecutionId: "e1",
        initiator: "agent",
        channelContext: { channel: "webchat", threadId },
      } as never,
      run,
    );

  it("is the chat its args send into, wherever it is made", async () => {
    const id = await inChat("chat-a", () =>
      repo.create({
        name: "Daily summary",
        trigger: DAILY,
        actionName: "send_user_message",
        args: { sessionId: "chat-b" },
      }),
    );
    expect(await chatOf(id)).toBe("chat-b");
  });

  it("is else the chat it is made in: the one named, or the webchat chat whose turn makes it", async () => {
    const named = await repo.create({
      name: "Wake",
      trigger: DAILY,
      actionName: "system:summon",
      args: { prompt: "check in" },
      chatId: routineChatOf("system:summon", { prompt: "check in" }, "chat-e"),
    });
    const inTurn = await inChat("chat-a", () =>
      repo.create({
        name: "Wake",
        trigger: DAILY,
        actionName: "system:summon",
        args: { prompt: "check in" },
      }),
    );
    expect([await chatOf(named), await chatOf(inTurn)]).toEqual(["chat-e", "chat-a"]);
  });

  it("is the chat its args send into, made outside any chat", async () => {
    const send = await repo.create({
      name: "Summary",
      trigger: DAILY,
      actionName: "system:send_user_message",
      args: { sessionId: "chat-b" },
    });
    const check = await repo.create({
      name: "Check",
      trigger: DAILY,
      actionName: "resume_session",
      args: { threadId: "chat-c", sessionId: "s" },
    });
    const elsewhere = await repo.create({
      name: "Webhook",
      trigger: DAILY,
      actionName: "core:something",
      args: { threadId: "chat-d" },
    });
    expect([await chatOf(send), await chatOf(check), await chatOf(elsewhere)]).toEqual([
      "chat-b",
      "chat-c",
      null,
    ]);
    expect((await repo.findByChat("chat-b")).map((row) => row.id)).toEqual([send]);
  });

  it("stays none for a shared routine, even made in a chat's turn", async () => {
    const id = await inChat("chat-a", () =>
      repo.create({
        name: "Digest",
        trigger: DAILY,
        actionName: "core:concierge_digest",
        args: {},
        chatId: null,
      }),
    );
    expect(await chatOf(id)).toBeNull();
  });
});

describe("a routine that reads personal data", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  // Only "guardian-chat" is private, as only the guardian's own dashboard chat is.
  const repoWith = () =>
    new RoutinesRepository(testDb.db, async (chatId) =>
      chatId === "guardian-chat" ? "private" : "shared",
    );
  const query = (madeIn?: string) => ({
    name: "Morning steps",
    trigger: DAILY,
    actionName: "core:personal_data_query",
    args: { source: "apple_health", type: "stepCount" },
    ...(madeIn ? { madeIn } : {}),
  });

  it("is made for a private chat, and its fires read that chat's audience", async () => {
    const repo = repoWith();
    const id = await repo.create(query("guardian-chat"));
    expect(await repo.audienceOf(id)).toBe("private");
  });

  it("is refused when it is made for a shared chat or for no chat", async () => {
    const repo = repoWith();
    await expect(repo.create(query("group-chat"))).rejects.toThrow("personal_data_private_only");
    await expect(repo.create(query())).rejects.toThrow("personal_data_private_only");
    await expect(
      repo.create({ ...query("group-chat"), actionName: "personal_data_catalog" }),
    ).rejects.toThrow("personal_data_private_only");
  });

  it("is refused when an edit binds a shared routine to a personal-data action", async () => {
    const repo = repoWith();
    const id = await repo.create({ ...query("group-chat"), actionName: "send_user_message" });
    await expect(repo.update(id, { actionName: "core:personal_data_query" })).rejects.toThrow(
      "personal_data_private_only",
    );
  });

  it("is refused everywhere when Rome cannot tell who reads a chat", async () => {
    const repo = new RoutinesRepository(testDb.db);
    await expect(repo.create(query("guardian-chat"))).rejects.toThrow("personal_data_private_only");
    const other = await repo.create({ ...query("guardian-chat"), actionName: "send_user_message" });
    expect(await repo.audienceOf(other)).toBe("shared");
  });
});
