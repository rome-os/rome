import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { actionExecutions, romeAgentMessages, romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import {
  announceInterrupted,
  conciergeNoticeSender,
  describeInterrupted,
  interruptedNoticeText,
  RESTART_MARKER,
} from "../webchat/interrupted-notice.js";
import { TASK_CHAT_TRIGGER_KIND } from "../webchat/privacy.js";

const DAY = 24 * 60 * 60 * 1000;

describe("the restart notice", () => {
  let db: TestDb;
  let repo: ChatsWebChatRepository;
  let turns = 0;

  beforeEach(() => {
    db = createTestDb();
    repo = new ChatsWebChatRepository(db.db);
  });
  afterEach(() => db.close());

  /** A session with a turn running when the process died. `change` edits the stored session row. */
  async function running(
    id: string,
    change: Partial<typeof romeSessions.$inferInsert> = {},
    options: { prompt?: string; blocks?: Record<string, unknown>[]; create?: boolean } = {},
  ) {
    const turnId = `${id}-turn-${++turns}`;
    if (options.create !== false) {
      await repo.createSession(
        id,
        `Title of ${id}`,
        undefined,
        "default",
        null,
        "default",
        "core:main",
      );
      if (Object.keys(change).length > 0)
        await db.db.update(romeSessions).set(change).where(eq(romeSessions.id, id));
    }
    await repo.appendTraceBlocks({
      messageId: `${turnId}-trace`,
      sessionId: id,
      turnId,
      startSeq: 0,
      blocks: [
        {
          type: "turn_start",
          turnId,
          sessionId: `${id}-runtime`,
          userPrompt: options.prompt ?? "Do the work",
        },
        ...(options.blocks ?? []),
      ] as never,
    });
    return `${turnId}-trace`;
  }

  const describe_ = async (at = Date.now()) =>
    describeInterrupted(db.db, repo, await repo.endInterruptedTurns(DAY), at);

  it("sorts every kind of session, and skips subagent sessions", async () => {
    await running("guardian");
    await running("task", { triggerKind: TASK_CHAT_TRIGGER_KIND });
    await running("wake");
    await db.db
      .update(romeAgentMessages)
      .set({ triggerKind: "defer" })
      .where(eq(romeAgentMessages.sessionId, "wake"));
    await running("telegram", { type: "channel", chatPlatform: "telegram" });
    await db.db.insert(actionExecutions).values({
      id: "exec-1",
      rootExecutionId: "exec-1",
      actionName: "code-review_pr-review",
      status: "error",
      args: { prUrl: "https://github.com/o/r/pull/1" },
      startedAt: new Date(),
      createdAt: new Date(),
    });
    await running("run", { type: "action", rootActionExecutionId: "exec-1" });
    await running("sub", { type: "subagent", parentSessionId: "guardian" });
    const items = await describe_();
    const byId = new Map(items.map((item) => [item.sessionId, item]));
    expect([...byId.keys()].sort()).toEqual(["guardian", "run", "task", "telegram", "wake"]);
    expect(byId.get("guardian")).toMatchObject({
      kind: "guardian chat",
      title: "Title of guardian",
      agent: "core:main",
      reportOnly: null,
    });
    expect(byId.get("task")?.kind).toBe("Concierge task chat");
    expect(byId.get("wake")?.kind).toBe("wake-up turn (defer) in a chat");
    expect(byId.get("telegram")).toMatchObject({
      kind: "telegram channel chat",
      reportOnly: "report only: another channel",
    });
    expect(byId.get("run")?.kind).toBe(
      'app run code-review_pr-review {"prUrl":"https://github.com/o/r/pull/1"}',
    );
    expect(byId.has("sub")).toBe(false);
  });

  it("names the last tool call, and whether its result was recorded", async () => {
    const call = {
      type: "tool_use",
      id: "t1",
      tool: "Bash",
      input: { command: "git push origin main" },
    };
    await running("open", {}, { blocks: [call] });
    await running(
      "done",
      {},
      {
        blocks: [call, { type: "tool_result", toolUseId: "t1", tool: "Bash", output: "ok" }],
      },
    );
    const byId = new Map((await describe_()).map((item) => [item.sessionId, item]));
    expect(byId.get("open")?.lastStep).toBe(
      'Bash {"command":"git push origin main"} (outcome unknown)',
    );
    expect(byId.get("done")?.lastStep).toBe('Bash {"command":"git push origin main"}');
  });

  it("leaves out visitors, archived chats, a day of silence and notice turns", async () => {
    await running("keep");
    await running("visitor", { ownerKey: "visitor:acct" });
    await running("archived", { archivedAt: new Date() });
    await running("notice", {}, { prompt: `${RESTART_MARKER}Rome restarted` });
    const ended = await repo.endInterruptedTurns(DAY);
    expect(ended).toHaveLength(4);
    const ids = (at: number) => describeInterrupted(db.db, repo, ended, at).map((i) => i.sessionId);
    expect(ids(Date.now())).toEqual(["keep"]);
    expect(ids(Date.now() + 2 * DAY)).toEqual([]);
  });

  it("lists a turn a restart cut off twice as report only, and drops it the third time", async () => {
    await running("loop");
    expect(await describe_()).toMatchObject([{ reportOnly: null }]);
    await running("loop", {}, { create: false });
    expect(await describe_()).toMatchObject([{ reportOnly: "report only: cut by two restarts" }]);
    await running("loop", {}, { create: false });
    expect(await describe_()).toEqual([]);
  });

  it("lists a chat a usage limit stopped twice as report only, and drops it the third time", async () => {
    const stopped = {
      blocks: [
        { type: "error", error: "You've hit your limit", code: "usage_limit" },
        { type: "turn_end", turnId: "t", status: "error", durationMs: 1 },
      ],
    };
    const listed = (messageId: string) =>
      describeInterrupted(
        db.db,
        repo,
        [
          {
            agentName: "core:main",
            messageId,
            sessionId: "limit",
            turnId: "t",
            runtimeSessionId: null,
            prompt: "Do the work",
          },
        ],
        Date.now(),
        "usage_limit",
      );
    expect(listed(await running("limit", {}, stopped))).toMatchObject([{ reportOnly: null }]);
    const second = await running("limit", {}, { ...stopped, create: false });
    expect(listed(second)).toMatchObject([
      { reportOnly: "report only: stopped by the limit twice" },
    ]);
    expect(listed(await running("limit", {}, { ...stopped, create: false }))).toEqual([]);
  });

  describe("sending", () => {
    const sender = () => {
      const run = rs.fn(async () => ({ status: "ok" as const, data: {} }));
      const ensureChatId = rs.fn(async () => "concierge");
      return {
        run,
        ensureChatId,
        send: conciergeNoticeSender({
          db: db.db,
          concierge: { ensureChatId },
          actions: { run } as never,
        }),
      };
    };

    it("sends nothing when no turn qualifies", async () => {
      const { run, send } = sender();
      await announceInterrupted(db.db, repo, await repo.endInterruptedTurns(DAY), send);
      await running("visitor", { ownerKey: "visitor:acct" });
      await announceInterrupted(db.db, repo, await repo.endInterruptedTurns(DAY), send);
      expect(run).not.toHaveBeenCalled();
    });

    it("sends one ordinary message into the guardian's Concierge chat", async () => {
      await running("a");
      await running("b");
      const { run, send } = sender();
      await announceInterrupted(db.db, repo, await repo.endInterruptedTurns(DAY), send);
      expect(run).toHaveBeenCalledTimes(1);
      const [name, args, context] = run.mock.calls[0] as unknown as [
        string,
        { sessionId: string; text: string },
        object,
      ];
      expect(name).toBe("system:send_user_message");
      expect(args.sessionId).toBe("concierge");
      expect(args.text.split("\n")[0]).toContain(RESTART_MARKER);
      expect(args.text).toMatch(/\n1\. guardian chat "Title of [ab]" · core:main · id [ab] /);
      expect(args.text).toMatch(/\n2\. guardian chat "Title of [ab]"/);
      expect(args.text).toContain("system:send_user_message");
      expect(context).toMatchObject({ initiator: "system:restart-recovery" });
    });

    it("tells the Concierge a usage limit headline and a refused item", () => {
      const text = interruptedNoticeText(
        [
          {
            sessionId: "s",
            agent: "a",
            title: "t",
            kind: "guardian chat",
            startedAt: 0,
            lastActivityAt: 0,
            lastStep: null,
            reportOnly: null,
            nothingDone: true,
          },
        ],
        "Model usage on anthropic is available again; these chats stopped on its limit:",
      );
      expect(text).toContain("Model usage on anthropic is available again");
      expect(text).toContain("nothing was done");
    });

    it("never lets a failed send stop startup", async () => {
      await running("a");
      const send = rs.fn(async () => {
        throw new Error("no chat");
      });
      await expect(
        announceInterrupted(db.db, repo, await repo.endInterruptedTurns(DAY), send),
      ).resolves.toBeUndefined();
    });

    it("costs a crash loop at most two notices, even when the Concierge continues every time", async () => {
      await running("work");
      let notices = 0;
      let concierge = 0;
      const { send } = sender();
      for (let boot = 1; boot <= 4; boot++) {
        const ended = await repo.endInterruptedTurns(DAY);
        const counting = async (text: string) => {
          notices++;
          await send(text);
          // The Concierge's turn for the notice, and its message continuing the work, both cut off again.
          await running("concierge", {}, { prompt: text, create: ++concierge === 1 });
          await running("work", {}, { create: false });
        };
        await announceInterrupted(db.db, repo, ended, counting);
      }
      expect(notices).toBe(2);
    });
  });
});
