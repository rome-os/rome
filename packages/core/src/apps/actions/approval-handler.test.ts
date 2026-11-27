import { describe, expect, it, rs } from "@rstest/core";
import { currentSessionActor, runWithSessionActor } from "../../access/session-actor.js";
import { hashArgs } from "./replay.js";
import { ApprovalHandler, executionRequester, formatResultForAgent } from "./approval-handler.js";

describe("formatResultForAgent", () => {
  it("does not say an approved action's card was shown, because none is stored", () => {
    const text = formatResultForAgent({
      status: "show_widget",
      widget: { componentId: "today", text: "You ate twice today." },
    });

    expect(text).toContain('"today" card is not shown');
    expect(text).toContain("You ate twice today.");
  });
});

describe("delegated task approval binding", () => {
  const guardian = { kind: "guardian" as const, userId: "synthetic-seat", via: "cookie" as const };
  const visitor = {
    kind: "visitor" as const,
    accountId: "synthetic-v",
    email: "v@example.invalid",
  };
  function harness(requester = visitor as typeof visitor | undefined, status = "approved") {
    let claimed = false;
    const payload = {
      actionName: "synthetic:guarded",
      args: { value: "approved argument" },
      rootActionName: "synthetic:root",
      rootArgs: { value: "original argument" },
      rootExecutionId: "root-1",
      replayJournal: [
        {
          sequence: 0,
          actionName: "synthetic:guarded",
          argsHash: hashArgs({ value: "approved argument" }),
          args: { value: "approved argument" },
          result: null,
          status: "pending_approval",
        },
      ],
      sessionId: "task-session",
      agentName: "core:main",
      channelThreadKey: "webchat:task",
      channelContext: { channel: "webchat", threadId: "task", threadType: "private" },
    };
    const approvals = {
      findById: rs.fn(async () => ({
        status,
        type: "action_execution",
        payload,
        executedAt: null,
      })),
      claimExecution: rs.fn(async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      }),
      markExecuted: rs.fn(async () => {}),
      markExecutionFailed: rs.fn(async () => {}),
    };
    const ambient: unknown[] = [];
    const run = rs.fn(async () => {
      ambient.push(await currentSessionActor());
      return { status: "ok", data: {} };
    });
    const resumed: unknown[] = [];
    const agent = {
      async *run(params: unknown) {
        resumed.push(params);
        yield { type: "result", content: "done" };
      },
    };
    const resolve = rs.fn(async (_id: string) => requester);
    const backend = {
      runBackendSessionTask: async (
        _channel: string,
        _thread: string,
        fn: (ctx: { emit: () => void }) => Promise<void>,
      ) => fn({ emit: () => {} }),
    };
    const journal = {
      loadJournal: rs.fn(async () => [] as unknown[]),
    };
    const handler = new ApprovalHandler(
      approvals as never,
      journal as never,
      { run } as never,
      agent as never,
      backend as never,
      undefined,
      undefined,
      resolve,
    );
    return { handler, run, approvals, ambient, resumed, resolve, payload, journal };
  }

  it("keeps the requester, root arguments and journal instead of borrowing the approving guardian", async () => {
    const s = harness();
    await runWithSessionActor(guardian, () => s.handler.onApproved("approval-1"));
    expect(s.resolve).toHaveBeenCalledWith("root-1");
    expect(s.run).toHaveBeenCalledWith(
      "synthetic:root",
      { value: "original argument" },
      expect.objectContaining({
        actor: visitor,
        replayRootExecutionId: "root-1",
        replayJournal: s.payload.replayJournal,
        sessionId: "task-session",
        channelThreadKey: "webchat:task",
      }),
    );
    expect(s.ambient).toEqual([undefined]);
    expect(s.resumed).toEqual([
      expect.objectContaining({ actor: visitor, sessionId: "task-session" }),
    ]);
  });

  it("replays a chatless turn's call as that turn", async () => {
    const s = harness();
    const payload = s.payload as Record<string, unknown>;
    delete payload.channelContext;
    payload.turnId = "turn-7";
    await runWithSessionActor(guardian, () => s.handler.onApproved("approval-1"));
    const context = (s.run.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(context).toMatchObject({ turnId: "turn-7" });
    expect(context).not.toHaveProperty("channelContext", expect.anything());
  });

  it("does not promote an unattributed requester when the guardian approves", async () => {
    const s = harness(undefined);
    // Explicitly replace the default fixture requester with no recorded actor.
    s.resolve.mockResolvedValue(undefined);
    await runWithSessionActor(guardian, () => s.handler.onApproved("approval-1"));
    expect((s.run.mock.calls[0] as unknown[])[2]).not.toHaveProperty("actor");
    expect(s.resumed[0]).not.toHaveProperty("actor");
  });

  it("claims an approval only once under concurrent replay attempts", async () => {
    const s = harness();
    await Promise.all([s.handler.onApproved("approval-1"), s.handler.onApproved("approval-1")]);
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  it("marks an approval that binds to no journal entry as failed, not executed", async () => {
    const s = harness();
    // Two pending entries for the same call cannot be told apart, so the
    // payload binds nothing.
    (s.payload as Record<string, unknown>).replayJournal = [
      ...s.payload.replayJournal,
      { ...s.payload.replayJournal[0], sequence: 1 },
    ];
    await runWithSessionActor(guardian, () => s.handler.onApproved("approval-1"));
    expect(s.run).not.toHaveBeenCalled();
    expect(s.approvals.markExecutionFailed).toHaveBeenCalledWith(
      "approval-1",
      "approval could not be bound to a journal entry",
    );
    expect(s.approvals.markExecuted).not.toHaveBeenCalled();
  });

  it("replays from the live journal when it holds more than the card's snapshot", async () => {
    const s = harness();
    const liveJournal = [
      ...s.payload.replayJournal,
      {
        sequence: 1,
        actionName: "synthetic:sibling",
        argsHash: hashArgs({ id: 2 }),
        args: { id: 2 },
        result: { status: "ok" },
        status: "completed",
      },
    ];
    s.journal.loadJournal.mockResolvedValue(liveJournal);
    await runWithSessionActor(guardian, () => s.handler.onApproved("approval-1"));
    expect(s.run).toHaveBeenCalledWith(
      "synthetic:root",
      { value: "original argument" },
      expect.objectContaining({ replayJournal: liveJournal }),
    );
  });

  it("never runs a pending, unapproved call", async () => {
    const s = harness(visitor, "pending");
    await s.handler.onApproved("approval-1");
    expect(s.run).not.toHaveBeenCalled();
  });

  it("uses only the recorded root execution actor, never an absent row's fallback", async () => {
    const findById = rs.fn(async (_id: string): Promise<{ actor?: unknown } | null> => null);
    expect(await executionRequester({ findById })("missing-root")).toBeUndefined();
    findById.mockResolvedValue({ actor: visitor });
    expect(await executionRequester({ findById })("root-1")).toEqual(visitor);
  });
});
