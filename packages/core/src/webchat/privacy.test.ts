import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "./chats-webchat-repository.js";
import { type ChatPrivacyRow, PRIVATE_CHILD_TRIGGER_KIND, privateOwnerOf } from "./privacy.js";

const VISITOR = "visitor:a";

describe("whose Concierge a chat is, read off the chat's own row", () => {
  it("is its owner's for a Concierge chat, a task chat and their fork", () => {
    const rows: ChatPrivacyRow[] = [
      { id: "topic", agentName: "core:concierge", ownerKey: VISITOR },
      { id: "task", triggerKind: "concierge", ownerKey: VISITOR },
      { id: "branch", triggerKind: PRIVATE_CHILD_TRIGGER_KIND, ownerKey: VISITOR },
    ];
    for (const row of rows) expect(privateOwnerOf(row)).toBe(VISITOR);
    // The guardian's main chat records no owner, and is the guardian's.
    expect(privateOwnerOf({ id: "concierge", agentName: "core:concierge" })).toBe("guardian");
  });

  it("is no one's for an ordinary chat and an ordinary fork", () => {
    expect(privateOwnerOf({ id: "plain", ownerKey: "guardian" })).toBeNull();
    expect(privateOwnerOf({ id: "branch", triggerKind: "fork", ownerKey: "guardian" })).toBeNull();
  });

  describe("a child session", () => {
    let testDb: TestDb;
    let repo: ChatsWebChatRepository;
    beforeEach(() => {
      testDb = createTestDb();
      repo = new ChatsWebChatRepository(testDb.db);
    });
    afterEach(() => testDb.close());

    const chat = (id: string, ownerKey: string) =>
      repo.createSession(
        id,
        id,
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        "webchat",
        null,
        {
          ownerKey,
        },
      );

    it("of a member's task chat is theirs from the start, and after the task chat is gone", async () => {
      await chat("task", VISITOR);
      await repo.setSessionTrigger("task", { triggerKind: "concierge", triggerName: "Task" });
      for (const [id, type] of [
        ["subagent-1", "subagent"],
        ["fork-1", "fork"],
      ] as const) {
        await repo.ensureRomeSession({
          id,
          type,
          name: id,
          agentName: "researcher",
          parentSessionId: "task",
          ...(type === "fork" ? { trigger: { triggerKind: "fork", triggerName: "feedback" } } : {}),
        });
      }
      await repo.deleteSession("task");
      for (const id of ["subagent-1", "fork-1"]) {
        const row = await repo.getSession(id);
        expect(row).toMatchObject({ ownerKey: VISITOR, triggerKind: PRIVATE_CHILD_TRIGGER_KIND });
        expect(privateOwnerOf(row)).toBe(VISITOR);
      }
    });

    it("is not made when its parent is gone, and saves nothing", async () => {
      await expect(
        repo.ensureRomeSession({
          id: "orphan",
          type: "subagent",
          name: "orphan",
          agentName: "researcher",
          parentSessionId: "deleted-task",
        }),
      ).rejects.toThrow("was not found");
      expect(await repo.getSession("orphan")).toBeNull();
    });

    it("of an ordinary chat is no one's", async () => {
      await chat("plain", "guardian");
      await repo.ensureRomeSession({
        id: "subagent-2",
        type: "subagent",
        name: "s",
        agentName: "researcher",
        parentSessionId: "plain",
      });
      const row = await repo.getSession("subagent-2");
      expect(row?.triggerKind).toBeNull();
      expect(privateOwnerOf(row)).toBeNull();
    });
  });
});
