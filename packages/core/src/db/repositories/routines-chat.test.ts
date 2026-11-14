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
