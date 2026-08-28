import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { ActionEngine } from "./engine.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { hashArgs, ReplayDivergenceError } from "./replay.js";
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
    const engine = new ActionEngine(
      registry,
      undefined,
      executionsRepo,
      approvalsRepo,
      journalRepo,
    );

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
    const engine = new ActionEngine(
      registry,
      undefined,
      executionsRepo,
      approvalsRepo,
      journalRepo,
    );

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
    const replayResult = await engine.run(
      "parent",
      {},
      {
        replayJournal,
        divergenceMode: "fallthrough",
      },
    );

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

  it("divergence during replay throws in strict mode", async () => {
    const execA = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "A" }));
    const execX = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "X" }));

    const childA = makeAction("child_a", { execute: execA });
    const childX = makeAction("child_x", { execute: execX });

    const parent = makeAction("parent", {
      execute: async () => {
        // Always calls child_x — will diverge from journal entry for child_a
        const r = await callAction("child_x", { id: 1 });
        if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
        return { status: "ok", data: r.data };
      },
    });

    const registry = makeRegistry(parent, childA, childX);
    const engine = new ActionEngine(
      registry,
      undefined,
      executionsRepo,
      approvalsRepo,
      journalRepo,
    );

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

    await expect(
      engine.run(
        "parent",
        {},
        {
          replayJournal,
          divergenceMode: "strict",
        },
      ),
    ).rejects.toThrow(ReplayDivergenceError);

    // child_x should NOT have been executed (divergence is strict)
    expect(execX).not.toHaveBeenCalled();
  });
});
