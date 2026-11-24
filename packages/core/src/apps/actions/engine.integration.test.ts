import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../../test/db.js";
import { ActionEngine } from "./engine.js";
import { ApprovalsRepository } from "../repositories/approvals.js";
import { ExecutionJournalRepository } from "../repositories/execution-journal.js";
import { ActionExecutionsRepository } from "../repositories/action-executions.js";
import { hashArgs, type JournalEntry } from "./replay.js";
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
        approvedSequence: (payload.journalSequence as number) ?? 1,
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

  it("executes only the resolved card's entry; a rejected sibling's pending call is refused", async () => {
    const execA = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "A-result" }));
    const execB = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "B-result" }));

    const childA = makeAction("child_a", { requiresApproval: true, execute: execA });
    const childB = makeAction("child_b", { requiresApproval: true, execute: execB });
    const parent = makeAction("parent", {
      execute: async () => {
        const rA = await callAction("child_a", { id: 1 });
        const rB = await callAction("child_b", { id: 2 });
        return { status: "ok", data: [rA.status, rB.status] };
      },
    });

    const registry = makeRegistry(parent, childA, childB);
    const engine = new ActionEngine(registry, {
      executions: executionsRepo,
      approvals: approvalsRepo,
      journal: journalRepo,
    });

    const recorded = await engine.run("parent", {}, { initiator: "test" });
    if (recorded.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${recorded.status}`);
    }
    expect(execA).not.toHaveBeenCalled();
    expect(execB).not.toHaveBeenCalled();

    const pending = await approvalsRepo.findPending();
    const cardOf = (actionName: string) =>
      pending.find((row) => (row.payload as { actionName?: string }).actionName === actionName);
    const cardA = cardOf("child_a")!;
    const cardB = cardOf("child_b")!;
    const payloadA = cardA.payload as { journalSequence: number };
    const payloadB = cardB.payload as {
      journalSequence: number;
      replayJournal: JournalEntry[];
      rootExecutionId: string;
    };
    // Each card names the journal entry its own pending call recorded.
    expect(payloadA.journalSequence).toBe(0);
    expect(payloadB.journalSequence).toBe(1);

    // The guardian rejects child_a's card and approves child_b's.
    await approvalsRepo.resolvePending(cardA.id, "reject", "guardian");
    await approvalsRepo.resolvePending(cardB.id, "approve", "guardian");

    const replayResult = await engine.run(
      "parent",
      {},
      {
        initiator: `approval:${cardB.id}`,
        replayJournal: payloadB.replayJournal,
        replayRootExecutionId: payloadB.rootExecutionId,
        approvedSequence: payloadB.journalSequence,
      },
    );

    // child_b's resolved card ran its own entry. child_a's pending entry was
    // never authorized by that card, and its card is gone, so the call is
    // refused rather than parked on a fabricated empty approval id.
    expect(execA).not.toHaveBeenCalled();
    expect(execB).toHaveBeenCalledTimes(1);
    expect(replayResult).toEqual({ status: "ok", data: ["error", "ok"] });
  });

  it("serves an earlier-resolved sibling from the journal when cards resolve out of order", async () => {
    const execA = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "A-result" }));
    const execB = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "B-result" }));

    const childA = makeAction("child_a", { requiresApproval: true, execute: execA });
    const childB = makeAction("child_b", { requiresApproval: true, execute: execB });
    const parent = makeAction("parent", {
      execute: async () => {
        const rA = await callAction("child_a", { id: 1 });
        const rB = await callAction("child_b", { id: 2 });
        return { status: "ok", data: [rA.status, rB.status] };
      },
    });

    const registry = makeRegistry(parent, childA, childB);
    const engine = new ActionEngine(registry, {
      executions: executionsRepo,
      approvals: approvalsRepo,
      journal: journalRepo,
    });

    const recorded = await engine.run("parent", {}, { initiator: "test" });
    if (recorded.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${recorded.status}`);
    }

    const pending = await approvalsRepo.findPending();
    const cardOf = (actionName: string) =>
      pending.find((row) => (row.payload as { actionName?: string }).actionName === actionName)!;
    const cardA = cardOf("child_a");
    const cardB = cardOf("child_b");
    const payloadB = cardB.payload as { journalSequence: number; rootExecutionId: string };
    const payloadA = cardA.payload as { journalSequence: number; rootExecutionId: string };
    const rootExecutionId = payloadB.rootExecutionId;

    // Approve the later card first: child_b executes, then the replay parks
    // on child_a's still-pending card.
    await approvalsRepo.resolvePending(cardB.id, "approve", "guardian");
    const replayB = await engine.run(
      "parent",
      {},
      {
        initiator: `approval:${cardB.id}`,
        replayJournal: await journalRepo.loadJournal(rootExecutionId),
        replayRootExecutionId: rootExecutionId,
        approvedSequence: payloadB.journalSequence,
      },
    );
    expect(execA).not.toHaveBeenCalled();
    expect(execB).toHaveBeenCalledTimes(1);
    if (replayB.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${replayB.status}`);
    }
    expect(replayB.approval.approvalId).toBe(cardA.id);

    // Approve the earlier card second: child_a executes and the completed
    // sibling entry is consumed from the journal instead of running again.
    await approvalsRepo.resolvePending(cardA.id, "approve", "guardian");
    const replayA = await engine.run(
      "parent",
      {},
      {
        initiator: `approval:${cardA.id}`,
        replayJournal: await journalRepo.loadJournal(rootExecutionId),
        replayRootExecutionId: rootExecutionId,
        approvedSequence: payloadA.journalSequence,
      },
    );
    expect(execA).toHaveBeenCalledTimes(1);
    expect(execB).toHaveBeenCalledTimes(1);
    expect(replayA).toEqual({ status: "ok", data: ["ok", "ok"] });

    // No second card for the already-executed sibling and no duplicate
    // journal sequence was recorded. Executed entries are also re-appended
    // as fresh completed rows, a pre-existing quirk of replay.
    expect(await approvalsRepo.findPending()).toHaveLength(0);
    const journal = await journalRepo.loadJournal(rootExecutionId);
    expect(journal.every((e) => e.status === "completed")).toBe(true);
    expect(new Set(journal.map((e) => e.sequence)).size).toBe(journal.length);
  });

  it("runs one pending entry once when concurrent calls share one resolved card", async () => {
    const exec = rs.fn(async (): Promise<ActionResult> => ({ status: "ok", data: "done" }));
    const child = makeAction("child", { requiresApproval: true, execute: exec });
    const parent = makeAction("parent", {
      execute: async () => {
        const [r1, r2] = await Promise.all([
          callAction("child", { id: 1 }),
          callAction("child", { id: 1 }),
        ]);
        return { status: "ok", data: [r1.status, r2.status] };
      },
    });

    const registry = makeRegistry(parent, child);
    const engine = new ActionEngine(registry, {
      executions: executionsRepo,
      approvals: approvalsRepo,
      journal: journalRepo,
    });

    const recorded = await engine.run("parent", {}, { initiator: "test" });
    if (recorded.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${recorded.status}`);
    }
    const pending = await approvalsRepo.findPending();
    const cardOf = (journalSequence: number) =>
      pending.find(
        (row) => (row.payload as { journalSequence?: number }).journalSequence === journalSequence,
      );
    const card0 = cardOf(0)!;
    const card1 = cardOf(1)!;
    const rootExecutionId = (card0.payload as { rootExecutionId: string }).rootExecutionId;
    const journal = await journalRepo.loadJournal(rootExecutionId);
    await approvalsRepo.resolvePending(card0.id, "approve", "guardian");
    exec.mockClear();

    const replayResult = await engine.run(
      "parent",
      {},
      {
        initiator: `approval:${card0.id}`,
        replayJournal: journal,
        replayRootExecutionId: rootExecutionId,
        approvedSequence: 0,
      },
    );

    // The resolved card covers exactly one journal entry: the second
    // concurrent call lands on its own still-pending entry, not on the slot
    // the approved card owns, so the effect ran once.
    expect(exec).toHaveBeenCalledTimes(1);
    if (replayResult.status !== "pending_approval") {
      throw new Error(`expected pending_approval, got ${replayResult.status}`);
    }
    expect(replayResult.approval.approvalId).toBe(card1.id);
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
