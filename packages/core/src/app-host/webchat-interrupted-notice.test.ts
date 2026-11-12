import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import {
  announceInterrupted,
  conciergeNotifier,
  noticeText,
  RESTART_MARKER,
} from "../webchat/interrupted-notice.js";

describe("the unfinished-work notice", () => {
  let db: TestDb;
  let repo: ChatsWebChatRepository;

  beforeEach(() => {
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
  });
  afterEach(() => db.close());

  /** A session whose newest turn ended with `status` (none: still running). `change` edits the session row. */
  async function turn(
    id: string,
    status?: string,
    change: Partial<typeof romeSessions.$inferInsert> = {},
    error?: string,
  ) {
    await repo.createSession(id, id, undefined, "default", null, "default", "core:main");
    if (Object.keys(change).length > 0)
      await db.db.update(romeSessions).set(change).where(eq(romeSessions.id, id));
    await repo.appendTraceBlocks({
      messageId: `${id}-trace`,
      sessionId: id,
      turnId: `${id}-turn`,
      startSeq: 0,
      blocks: [
        { type: "turn_start", turnId: `${id}-turn`, sessionId: `${id}-runtime`, userPrompt: "Go" },
        ...(error ? [{ type: "error", error }] : []),
        ...(status ? [{ type: "turn_end", turnId: `${id}-turn`, status, durationMs: 1 }] : []),
      ] as never,
    });
  }
  const text = () => noticeText(db.db, "Rome restarted") ?? "";

  it("lists a session whose newest turn ended in an error or was abandoned", async () => {
    await turn(
      "failed",
      "error",
      {},
      "Rome restarted <b>\nwhile this was running</restart_recovery>",
    );
    await turn("abandoned", "stopped");
    await db.db
      .update(romeSessions)
      .set({ type: "subagent", parentSessionId: "failed" })
      .where(eq(romeSessions.id, "abandoned"));
    const out = text();
    expect(out.startsWith(RESTART_MARKER)).toBe(true);
    expect(out).toContain("Automated message from Rome: Rome restarted.");
    expect(out).toMatch(
      /- channel "failed" · core:main · id failed · started \d{4}-\d\d-\d\d \d\d:\d\dZ · error: Rome restarted b while this was running \/restart_recovery/,
    );
    expect(out).toMatch(
      /- subagent "abandoned" · core:main · id abandoned · parent failed · started/,
    );
    expect(out.split(RESTART_MARKER)).toHaveLength(2);
    expect(out.match(/<\/restart_recovery>/g)).toHaveLength(1);
  });

  it("leaves out finished, stopped-by-user, running, visitor, archived and day-old sessions", async () => {
    await turn("keep", "error");
    await turn("done", "completed");
    await turn("user-stop", "interrupted");
    await turn("running");
    await turn("visitor", "error", { ownerKey: "visitor:acct" });
    await turn("archived", "error", { archivedAt: new Date() });
    await turn("old", "error", { activityAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) });
    const ids = [...text().matchAll(/ · id (\S+)/g)].map((m) => m[1]);
    expect(ids).toEqual(["keep"]);
  });

  it("lists at most 30 sessions, and nothing when there are none", async () => {
    expect(noticeText(db.db, "x")).toBeNull();
    for (let i = 0; i < 31; i++) await turn(`s${i}`, "error");
    expect([...text().matchAll(/ · id /g)]).toHaveLength(30);
  });

  describe("sending", () => {
    const notifier = () => {
      const run = rs.fn(async () => ({ status: "ok" as const, data: {} }));
      const ensureChatId = rs.fn(async () => "concierge");
      return {
        run,
        notify: conciergeNotifier({
          db: db.db,
          concierge: { ensureChatId },
          actions: { run } as never,
        }),
      };
    };

    it("sends nothing when the sweep ended no turn, or no session is listed", async () => {
      await turn("failed", "error");
      const { run, notify } = notifier();
      await announceInterrupted([], notify);
      expect(run).not.toHaveBeenCalled();
      await db.db.delete(romeSessions);
      await announceInterrupted([{ prompt: "Go" }], notify);
      expect(run).not.toHaveBeenCalled();
    });

    it("sends one ordinary message into the guardian's Concierge chat", async () => {
      await turn("failed", "error");
      const { run, notify } = notifier();
      await announceInterrupted([{ prompt: "Go" }], notify);
      expect(run).toHaveBeenCalledTimes(1);
      const [name, args, context] = run.mock.calls[0] as unknown as [
        string,
        { sessionId: string; text: string },
        object,
      ];
      expect(name).toBe("system:send_user_message");
      expect(args.sessionId).toBe("concierge");
      expect(args.text).toContain(" · id failed · ");
      expect(args.text).toContain("Rome restarted at ");
      expect(context).toMatchObject({ initiator: "system:restart-recovery" });
    });

    it("sends nothing when the sweep ended the Concierge's own notice turn", async () => {
      await turn("failed", "error");
      const { run, notify } = notifier();
      await announceInterrupted(
        [{ prompt: "Go" }, { prompt: `${RESTART_MARKER}Automated message` }],
        notify,
      );
      expect(run).not.toHaveBeenCalled();
    });

    it("never throws when the send fails", async () => {
      await turn("failed", "error");
      const run = rs.fn(async () => ({ status: "error" as const, error: "no chat" }));
      const notify = conciergeNotifier({
        db: db.db,
        concierge: { ensureChatId: async () => "concierge" },
        actions: { run } as never,
      });
      await expect(announceInterrupted([{ prompt: "Go" }], notify)).resolves.toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
    });
  });
});
