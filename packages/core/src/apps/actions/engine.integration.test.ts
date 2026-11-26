import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/db.js";
import { ActionEngine } from "./engine.js";
import { ApprovalsRepository, type ApprovalRow } from "../repositories/approvals.js";
import { ExecutionJournalRepository } from "../repositories/execution-journal.js";
import { ActionExecutionsRepository } from "../repositories/action-executions.js";
import { hashArgs } from "./replay.js";
import { callAction } from "./call-action.js";
import type { Action, ActionConfig, ActionRegistry, ActionResult } from "./types.js";

// Helpers

const defaultConfig: ActionConfig = {
  name: "test",
  type: "system",
  description: "test action",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "read-only",
};

function makeAction(
  name: string,
  overrides?: Partial<ActionConfig> & {
    execute?: (args: Record<string, unknown>) => Promise<ActionResult>;
  },
): Action {
  const { execute, ...configOverrides } = overrides ?? {};
  return {
    config: { ...defaultConfig, name, ...configOverrides },
    execute: execute ?? rs.fn(async (): Promise<ActionResult> => ({ status: "ok" })),
  };
}

function makeRegistry(...actions: Action[]): ActionRegistry {
  const map = new Map<string, Action>();
  for (const a of actions) map.set(a.config.name, a);
  return {
    register: rs.fn((a: Action) => map.set(a.config.name, a)),
    get: rs.fn((n: string) => map.get(n)),
    has: rs.fn((n: string) => map.has(n)),
    list: rs.fn(() => [...map.keys()]),
    getForAgent: rs.fn(
      (names: string[]) => names.map((n) => map.get(n)).filter(Boolean) as Action[],
    ),
  };
}

// Integration Tests

describe("Approval flow integration", () => {
  let testDb: TestDb;
  let approvalsRepo: ApprovalsRepository;
  let journalRepo: ExecutionJournalRepository;
  let executionsRepo: ActionExecutionsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    approvalsRepo = new ApprovalsRepository(testDb.db);
    journalRepo = new ExecutionJournalRepository(testDb.db);
    executionsRepo = new ActionExecutionsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  it("record → approval exception → journal persisted → replay → action executes → completes", async () => {
    const execA = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "A-result" }));
    const execB = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "B-result" }));

    const childA = makeAction("child_a", { execute: execA });
    const childB = makeAction("child_b", {
      requiresApproval: true,
      execute: execB,
    });
    const parent = makeAction("parent", {
      execute: async () => {
        // During record, child_b parks on its approval gate and returns a
        // pending result — the parent must complete anyway (the engine
        // surfaces the pending signal at the root).
        const dataOf = (r: ActionResult) => (r.status === "ok" ? r.data : undefined);
        const rA = await callAction("child_a", { id: 1 });
        const rB = await callAction("child_b", { id: 2 });
        return { status: "ok", data: [dataOf(rA), dataOf(rB)] };
      },
    });

    const registry = makeRegistry(parent, childA, childB);
    const engine = new ActionEngine(registry, {
      executions: executionsRepo,
      approvals: approvalsRepo,
      journal: journalRepo,
    });

    const recordResult = await engine.run(
      "parent",
      {},
      {
        initiator: "test",
        channelContext: { channel: "telegram", threadId: "t-1" },
        sessionId: "sess-1",
      },
    );

    if (recordResult.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${recordResult.status}`);
    }
    expect(recordResult.approval.actionName).toBe("child_b");

    // child_a was executed, child_b was NOT (requires approval)
    expect(execA).toHaveBeenCalledTimes(1);
    expect(execB).not.toHaveBeenCalled();

    const approvalId = recordResult.approval.approvalId;
    const approval = await approvalsRepo.findById(approvalId);
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe("pending");

    const payload = approval!.payload as Record<string, unknown>;
    const rootExecutionId = payload.rootExecutionId as string;
    const journal = await journalRepo.loadJournal(rootExecutionId);

    expect(journal).toHaveLength(2);
    expect(journal[0]).toMatchObject({
      actionName: "child_a",
      status: "completed",
      result: { status: "ok", data: "A-result" },
    });
    expect(journal[1]).toMatchObject({
      actionName: "child_b",
      status: "pending_approval",
      result: null,
    });

    execA.mockClear();

    const replayResult = await engine.run(
      "parent",
      {},
      {
        initiator: `approval:${approvalId}`,
        replayJournal: journal,
        replayRootExecutionId: rootExecutionId,
        approvedSequence: payload.journalSequence as number,
      },
    );

    // child_a was NOT re-executed (cached from journal)
    expect(execA).not.toHaveBeenCalled();
    // child_b WAS executed
    expect(execB).toHaveBeenCalledTimes(1);
    expect(execB).toHaveBeenCalledWith(
      { id: 2 },
      expect.objectContaining({ emitActionEvent: expect.any(Function) }),
    );

    // Parent completed with full result
    expect(replayResult).toEqual({
      status: "ok",
      data: ["A-result", "B-result"],
    });
  });

  describe("replay binds to the approved card's entry", () => {
    const ok = (data?: unknown) =>
      rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data }));
    const guarded = (name: string, execute = ok()) =>
      makeAction(name, { requiresApproval: true, execute });
    const parentOf = (execute: () => Promise<ActionResult>) => makeAction("parent", { execute });
    const statuses = (...results: ActionResult[]) => results.map((r) => r.status);

    function engineFor(...actions: Action[]) {
      return new ActionEngine(makeRegistry(...actions), {
        executions: executionsRepo,
        approvals: approvalsRepo,
        journal: journalRepo,
      });
    }

    async function recordCards(engine: ActionEngine): Promise<ApprovalRow[]> {
      expect((await engine.run("parent", {}, { initiator: "test" })).status).toBe(
        "pending_approval",
      );
      return approvalsRepo.findPending();
    }

    const payloadOf = (card: ApprovalRow) =>
      card.payload as { actionName: string; journalSequence: number; rootExecutionId: string };
    const cardFor = (cards: ApprovalRow[], match: string | number) =>
      cards.find((c) =>
        typeof match === "number"
          ? payloadOf(c).journalSequence === match
          : payloadOf(c).actionName === match,
      )!;
    const journalOf = (card: ApprovalRow) =>
      journalRepo.loadJournal(payloadOf(card).rootExecutionId);

    /** What ApprovalHandler does for one card: approve, then replay the live journal. */
    async function approveAndReplay(engine: ActionEngine, card: ApprovalRow) {
      const { rootExecutionId, journalSequence } = payloadOf(card);
      await approvalsRepo.resolvePending(card.id, "approve", "guardian");
      return engine.run(
        "parent",
        {},
        {
          initiator: `approval:${card.id}`,
          replayJournal: await journalRepo.loadJournal(rootExecutionId),
          replayRootExecutionId: rootExecutionId,
          approvedSequence: journalSequence,
        },
      );
    }

    function twoSiblings(stopOnError = false) {
      const execA = ok();
      const execB = ok();
      const engine = engineFor(
        guarded("child_a", execA),
        guarded("child_b", execB),
        parentOf(async () => {
          const rA = await callAction("child_a", {});
          if (stopOnError && rA.status === "error") return rA;
          const rB = await callAction("child_b", {});
          return { status: "ok", data: statuses(rA, rB) };
        }),
      );
      return { engine, execA, execB };
    }

    it("runs only its own entry; a rejected sibling is refused", async () => {
      const { engine, execA, execB } = twoSiblings();
      const cards = await recordCards(engine);
      expect([0, 1].map((seq) => payloadOf(cardFor(cards, seq)).actionName)).toEqual([
        "child_a",
        "child_b",
      ]);
      await approvalsRepo.resolvePending(cardFor(cards, "child_a").id, "reject", "guardian");

      const result = await approveAndReplay(engine, cardFor(cards, "child_b"));
      expect(execA).not.toHaveBeenCalled();
      expect(execB).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ status: "ok", data: ["error", "ok"] });
    });

    it("serves a sibling resolved earlier from the journal when cards resolve out of order", async () => {
      const { engine, execA, execB } = twoSiblings();
      const cards = await recordCards(engine);
      const [cardA, cardB] = [cardFor(cards, "child_a"), cardFor(cards, "child_b")];

      const first = await approveAndReplay(engine, cardB);
      expect(first.status === "pending_approval" && first.approval.approvalId).toBe(cardA.id);
      expect(await approveAndReplay(engine, cardA)).toEqual({ status: "ok", data: ["ok", "ok"] });

      expect([execA.mock.calls.length, execB.mock.calls.length]).toEqual([1, 1]);
      expect(await approvalsRepo.findPending()).toHaveLength(0);
      const journal = await journalOf(cardA);
      expect(journal.map((e) => [e.sequence, e.status])).toEqual([
        [0, "completed"],
        [1, "completed"],
      ]);
    });

    it("waits on an approved sibling that has not run yet", async () => {
      const { engine, execB } = twoSiblings(true);
      const cards = await recordCards(engine);
      await approvalsRepo.resolvePending(cardFor(cards, "child_a").id, "approve", "guardian");

      const result = await approveAndReplay(engine, cardFor(cards, "child_b"));
      expect(result.status === "pending_approval" && result.approval.approvalId).toBe(
        cardFor(cards, "child_a").id,
      );
      expect(execB).toHaveBeenCalledTimes(1);
    });

    it("reruns an unguarded call recorded after the approved one", async () => {
      let value = 0;
      const engine = engineFor(
        guarded(
          "write",
          rs.fn(async (): Promise<ActionResult> => {
            value = 1;
            return { status: "ok" };
          }),
        ),
        makeAction("read", { execute: async () => ({ status: "ok", data: value }) }),
        parentOf(async () => {
          await callAction("write", {});
          return callAction("read", {});
        }),
      );
      const [card] = await recordCards(engine);

      expect(await approveAndReplay(engine, card)).toEqual({ status: "ok", data: 1 });
      expect((await journalOf(card)).map((e) => e.status)).toEqual(["completed", "completed"]);
    });

    it("asks again for a new identical call made after the approved one", async () => {
      const exec = ok();
      const engine = engineFor(
        guarded("child", exec),
        parentOf(async () => {
          const first = await callAction("child", { id: 1 });
          if (first.status === "pending_approval") return { status: "ok" };
          return callAction("child", { id: 1 });
        }),
      );
      const [card] = await recordCards(engine);

      expect((await approveAndReplay(engine, card)).status).toBe("pending_approval");
      expect(exec).toHaveBeenCalledTimes(1);
      const [next] = await approvalsRepo.findPending();
      expect(payloadOf(next).journalSequence).toBe(1);
      expect((await journalOf(card)).map((e) => e.status)).toEqual([
        "completed",
        "pending_approval",
      ]);
    });

    it("gives concurrent identical calls one entry each", async () => {
      const exec = ok();
      const engine = engineFor(
        guarded("child", exec),
        parentOf(async () => {
          const results = await Promise.all([
            callAction("child", { id: 1 }),
            callAction("child", { id: 1 }),
          ]);
          return { status: "ok", data: statuses(...results) };
        }),
      );
      const cards = await recordCards(engine);

      const first = await approveAndReplay(engine, cardFor(cards, 0));
      expect(exec).toHaveBeenCalledTimes(1);
      expect(first.status === "pending_approval" && first.approval.approvalId).toBe(
        cardFor(cards, 1).id,
      );
      expect(await approveAndReplay(engine, cardFor(cards, 1))).toEqual({
        status: "ok",
        data: ["ok", "ok"],
      });
      expect(exec).toHaveBeenCalledTimes(2);
    });

    it("serves concurrent cached reads before running the approved call", async () => {
      const read1 = ok("r1");
      const read2 = ok("r2");
      const exec = ok("done");
      const engine = engineFor(
        makeAction("r1", { execute: read1 }),
        makeAction("r2", { execute: read2 }),
        guarded("child", exec),
        parentOf(async () => {
          await Promise.all([callAction("r1", {}), callAction("r2", {})]);
          return callAction("child", {});
        }),
      );
      const [card] = await recordCards(engine);

      expect(await approveAndReplay(engine, card)).toEqual({ status: "ok", data: "done" });
      expect([read1, read2, exec].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
      expect((await journalOf(card)).some((e) => e.status === "diverged")).toBe(false);
    });

    it("records the approved call's own nested calls without consuming sibling entries", async () => {
      const helper = ok();
      const execB = ok();
      const engine = engineFor(
        makeAction("helper", { execute: helper }),
        guarded(
          "child_a",
          rs.fn(async () => callAction("helper", {})),
        ),
        guarded("child_b", execB),
        parentOf(async () => {
          const rA = await callAction("child_a", {});
          const rB = await callAction("child_b", {});
          return { status: "ok", data: statuses(rA, rB) };
        }),
      );
      const cards = await recordCards(engine);
      const cardB = cardFor(cards, "child_b");

      const first = await approveAndReplay(engine, cardFor(cards, "child_a"));
      expect(helper).toHaveBeenCalledTimes(1);
      expect(first.status === "pending_approval" && first.approval.approvalId).toBe(cardB.id);
      expect((await approvalsRepo.findPending()).map((c) => c.id)).toEqual([cardB.id]);

      expect(await approveAndReplay(engine, cardB)).toEqual({ status: "ok", data: ["ok", "ok"] });
      expect([helper.mock.calls.length, execB.mock.calls.length]).toEqual([1, 1]);
      expect((await journalOf(cardB)).some((e) => e.status === "diverged")).toBe(false);
    });
  });

  it("divergence during replay falls through gracefully in default mode", async () => {
    const execA = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "A" }));
    const execX = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "X" }));

    const childA = makeAction("child_a", { execute: execA });
    const childX = makeAction("child_x", { execute: execX });

    // During record: parent calls child_a, then child_b (approval)
    // During replay: parent calls child_x (divergence!), then child_b
    let callCount = 0;
    const parent = makeAction("parent", {
      execute: async () => {
        callCount++;
        if (callCount === 1) {
          // First run (record): calls child_a
          const r = await callAction("child_a", { id: 1 });
          if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
          return { status: "ok", data: r.data };
        } else {
          // Replay: calls child_x instead (divergence)
          const r = await callAction("child_x", { id: 1 });
          if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
          return { status: "ok", data: r.data };
        }
      },
    });

    const registry = makeRegistry(parent, childA, childX);
    const engine = new ActionEngine(registry, {
      executions: executionsRepo,
      approvals: approvalsRepo,
      journal: journalRepo,
    });

    // Record a journal entry for child_a
    const recordResult = await engine.run("parent", {});
    if (recordResult.status !== "ok") {
      throw new Error(`expected ok, got ${recordResult.status}`);
    }
    expect(recordResult.data).toBe("A");

    // Load the journal (will have child_a as completed)
    // We need to find the rootExecutionId. Since we ran without replayJournal,
    // the journal is persisted under a UUID. Let's retrieve it from the save calls.
    // For this test we'll construct a replay journal manually.
    const replayJournal = [
      {
        sequence: 0,
        actionName: "child_a",
        argsHash: hashArgs({ id: 1 }),
        args: { id: 1 },
        result: { status: "ok" as const, data: "A" },
        status: "completed" as const,
      },
    ];

    // Replay — parent now calls child_x, which diverges from child_a
    const replayResult = await engine.run("parent", {}, { replayJournal });

    // Should succeed — child_x was executed despite divergence
    if (replayResult.status !== "ok") {
      throw new Error(`expected ok, got ${replayResult.status}`);
    }
    expect(replayResult.data).toBe("X");
    expect(execX).toHaveBeenCalledWith(
      { id: 1 },
      expect.objectContaining({ emitActionEvent: expect.any(Function) }),
    );
  });
});

describe("Execution records and omitted arguments", () => {
  let testDb: TestDb;
  let executionsRepo: ActionExecutionsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    executionsRepo = new ActionExecutionsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  const engineFor = (...actions: Action[]) =>
    new ActionEngine(makeRegistry(...actions), {
      executions: executionsRepo,
      approvals: new ApprovalsRepository(testDb.db),
      journal: new ExecutionJournalRepository(testDb.db),
    });

  it("records an omitted argument by its size only, and still passes it to the action", async () => {
    const execute = rs.fn(async (): Promise<ActionResult> => ({ status: "ok" }));
    const parentOf = rs.fn(async (): Promise<ActionResult> => {
      await callAction("child", { payload: { body: "nested keeps its args" } });
      return { status: "ok" };
    });
    const engine = engineFor(
      makeAction("root", { execute: parentOf }),
      makeAction("child", { execute }),
      makeAction("plain", { execute }),
    );
    const payload = { body: "a whole mail".repeat(20) };

    await engine.run(
      "root",
      { source: "gmail", payload },
      { initiator: "test", executionId: "r1", omitFromRecord: ["payload"] },
    );
    const root = await executionsRepo.findById("r1");
    expect(root?.args).toEqual({
      source: "gmail",
      payload: { omitted: true, bytes: JSON.stringify(payload).length },
    });
    // A nested call does not inherit it.
    expect(execute).toHaveBeenCalledWith(
      { payload: { body: "nested keeps its args" } },
      expect.anything(),
    );

    await engine.run("plain", { payload }, { initiator: "test", executionId: "r2" });
    expect((await executionsRepo.findById("r2"))?.args).toEqual({ payload });
  });
});
