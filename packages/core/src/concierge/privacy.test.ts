import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import {
  type ChatPrivacyRow,
  canOpen,
  canOpenChat,
  PRIVATE_CHILD_TRIGGER_KIND,
} from "./privacy.js";

const VISITOR = "visitor:a";

describe("chat privacy, read off the chat's own row", () => {
  it("opens a Concierge chat, a task chat and a private fork only for their owner", () => {
    const rows: ChatPrivacyRow[] = [
      { id: "topic", agentName: "core:concierge", ownerKey: VISITOR },
      { id: "task", triggerKind: "concierge", ownerKey: VISITOR },
      { id: "branch", triggerKind: PRIVATE_CHILD_TRIGGER_KIND, ownerKey: VISITOR },
    ];
    for (const row of rows) {
      expect(canOpen(row, VISITOR)).toBe(true);
      expect(canOpen(row, "guardian")).toBe(false);
      expect(canOpen(row, null)).toBe(false);
    }
    // The guardian's main chat records no owner, and is the guardian's.
    expect(canOpen({ id: "concierge", agentName: "core:concierge" }, "guardian")).toBe(true);
    expect(canOpen({ id: "concierge", agentName: "core:concierge" }, VISITOR)).toBe(false);
  });

  it("opens an ordinary chat and an ordinary fork for everyone", () => {
    expect(canOpen({ id: "plain", ownerKey: "guardian" }, VISITOR)).toBe(true);
    expect(canOpen({ id: "branch", triggerKind: "fork", ownerKey: "guardian" }, null)).toBe(true);
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

    it("of a visitor's task chat is private to them from the start, and after the task chat is gone", async () => {
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
        expect(canOpen(row, VISITOR)).toBe(true);
        expect(canOpen(row, "guardian")).toBe(false);
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

    it("a chat that cannot be found is open to no one", async () => {
      expect(await canOpenChat((id) => repo.getSession(id), "missing", "guardian")).toBe(false);
    });

    it("of an ordinary chat stays open", async () => {
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
      expect(canOpen(row, VISITOR)).toBe(true);
    });
  });
});
