import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { type ChatLineageRow, chatAccess, stampForkOwner } from "./privacy.js";

const VISITOR = "visitor:a";

/** The policy over a fixed set of rows, as a list reads them. */
const accessOver = (rows: ChatLineageRow[], owner: string | null) => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return chatAccess(async (id) => byId.get(id), owner);
};

describe("chat privacy along a line of forks", () => {
  it("keeps a chat private when its line cannot be followed to the end, at depth 9 or in a cycle", async () => {
    // The guardian's task chat, then nine forks, each from the one before.
    const rows: ChatLineageRow[] = [
      { id: "task", triggerKind: "concierge", ownerKey: "guardian" },
      ...Array.from({ length: 9 }, (_, index) => ({
        id: `fork-${index + 1}`,
        triggerKind: "fork",
        ownerKey: "guardian",
        parentSessionId: index === 0 ? "task" : `fork-${index}`,
      })),
    ];
    expect(await accessOver(rows, VISITOR).canOpen("fork-9")).toBe(false);
    expect(await accessOver(rows, "guardian").canOpen("fork-9")).toBe(true);

    const cycle: ChatLineageRow[] = [
      { id: "x", ownerKey: "guardian", parentSessionId: "y" },
      { id: "y", ownerKey: "guardian", parentSessionId: "x" },
    ];
    expect(await accessOver(cycle, VISITOR).canOpen("x")).toBe(false);
    expect(await accessOver(cycle, "guardian").canOpen("x")).toBe(true);
  });

  it("leaves an ordinary branch open when the ordinary chat it came from is gone", async () => {
    const rows: ChatLineageRow[] = [
      { id: "branch", triggerKind: "fork", ownerKey: "guardian", parentSessionId: "gone" },
    ];
    expect(await accessOver(rows, VISITOR).canOpen("branch")).toBe(true);
  });

  it("leaves an ordinary chat with no forked-from chat open to everyone", async () => {
    const rows: ChatLineageRow[] = [{ id: "plain", ownerKey: "guardian" }];
    expect(await accessOver(rows, VISITOR).canOpen("plain")).toBe(true);
  });

  describe("a promoted fork of a visitor's task chat", () => {
    let testDb: TestDb;
    let repo: ChatsWebChatRepository;
    beforeEach(() => {
      testDb = createTestDb();
      repo = new ChatsWebChatRepository(testDb.db);
    });
    afterEach(() => testDb.close());

    it("stays the visitor's after the task chat is deleted", async () => {
      await repo.createSession(
        "task",
        "Task",
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        "webchat",
        null,
        {
          ownerKey: VISITOR,
        },
      );
      await repo.setSessionTrigger("task", { triggerKind: "concierge", triggerName: "Task" });
      // The fork recorded some other owner when it was made.
      await repo.ensureRomeSession({
        id: "branch",
        type: "fork",
        name: "Branch",
        agentName: null,
        parentSessionId: "task",
      });
      await repo.setSessionOwnerKey("branch", "guardian");
      await stampForkOwner(repo, "branch");
      await repo.promoteForkToChat("branch");
      await repo.deleteSession("task");

      const canOpen = (owner: string) =>
        chatAccess((id) => repo.getSession(id), owner).canOpen("branch");
      expect(await canOpen(VISITOR)).toBe(true);
      expect(await canOpen("guardian")).toBe(false);
    });

    it("stamps no ordinary branch, which stays open after its chat is gone", async () => {
      await repo.createSession(
        "plain",
        "Plain",
        undefined,
        undefined,
        undefined,
        undefined,
        null,
        "webchat",
        null,
        {
          ownerKey: "guardian",
        },
      );
      await repo.ensureRomeSession({
        id: "branch",
        type: "fork",
        name: "Branch",
        agentName: null,
        parentSessionId: "plain",
        trigger: { triggerKind: "fork", triggerName: "branch" },
      });
      await stampForkOwner(repo, "branch");
      await repo.promoteForkToChat("branch");
      await repo.deleteSession("plain");
      expect((await repo.getSession("branch"))?.triggerKind).toBe("fork");
      expect(await chatAccess((id) => repo.getSession(id), VISITOR).canOpen("branch")).toBe(true);
    });
  });
});
