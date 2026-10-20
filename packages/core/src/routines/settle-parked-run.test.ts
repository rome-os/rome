import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { ActionCancelledError } from "../actions/action-errors.js";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import { ApprovalHandler } from "../actions/approval-handler.js";
import { recoverInterruptedApprovals } from "../actions/approval-recovery.js";
import { createBackendTurnRunner } from "../actions/backend-turn.js";
import type { Action, ActionResult } from "../actions/types.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { ApprovalsRepository } from "../db/repositories/approvals.js";
import { ExecutionJournalRepository } from "../db/repositories/execution-journal.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { systemClock } from "../lib/clock.js";
import { createMockAgentRunner, createTestDb, type TestDb } from "../test/helpers.js";
import { RoutineEngine } from "./engine.js";
import {
  routineRunApprovalHooks,
  settleParkedRun,
  settleResolvedParkedRuns,
} from "./settle-parked-run.js";

function makeAction(
  name: string,
  execute: Action["execute"],
  requiresApproval = false,
): Action & { calls: number } {
  const action = {
    config: {
      name,
      type: "system" as const,
      description: "test action",
      complexity: "simple" as const,
      speed: "fast" as const,
      reliability: "high" as const,
      sideEffects: "read-only" as const,
      requiresApproval,
    },
    calls: 0,
    execute: async (args: Record<string, unknown>, ctx: Parameters<Action["execute"]>[1]) => {
      action.calls++;
      return execute(args, ctx);
    },
  };
  return action;
}

const ok = async (): Promise<ActionResult> => ({ status: "ok" });

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("routine runs parked on approval", () => {
  let testDb: TestDb;
  let approvals: ApprovalsRepository;
  let executions: ActionExecutionsRepository;
  let routines: RoutinesRepository;
  let routineRuns: RoutineRunsRepository;
  let registry: ActionRegistryImpl;
  let engine: ActionEngine;
  let handler: ApprovalHandler;
  let routineEngine: RoutineEngine;
  // Runs while the engine announces a new approval, before the run that
  // requested it finishes parking.
  let whileAnnouncingApproval: ((approvalId: string) => Promise<void>) | undefined;

  beforeEach(() => {
    whileAnnouncingApproval = undefined;
    testDb = createTestDb();
    approvals = new ApprovalsRepository(testDb.db);
    executions = new ActionExecutionsRepository(testDb.db);
    routines = new RoutinesRepository(testDb.db);
    routineRuns = new RoutineRunsRepository(testDb.db);
    const journal = new ExecutionJournalRepository(testDb.db);
    registry = new ActionRegistryImpl();
    // "worker" keeps the root in-process, so the in-memory registry is visible.
    engine = new ActionEngine(
      registry,
      { executions, approvals, journal },
      {
        processRole: "worker",
        onApprovalCreated: async ({ approvalId }) => {
          await whileAnnouncingApproval?.(approvalId);
        },
      },
    );
    const agentRunner = createMockAgentRunner();
    handler = new ApprovalHandler(
      approvals,
      journal,
      engine,
      agentRunner,
      createBackendTurnRunner({ agentRunner, channel: () => null }),
      undefined,
      { executions, ...routineRunApprovalHooks({ executions, approvals, routineRuns }) },
    );
    routineEngine = new RoutineEngine(routines, routineRuns, engine, 0, systemClock, (rootId) =>
      settleParkedRun({ executions, approvals, routineRuns }, rootId, new Date()).then(() => {}),
    );
  });

  afterEach(() => {
    testDb.close();
  });

  async function fire(actionName: string) {
    const routineId = await routines.create({
      name: "nightly",
      trigger: { type: "manual" },
      actionName,
      args: {},
    });
    const outcome = await routineEngine.runNow(routineId);
    const run = (await routineRuns.findById(outcome.runId))!;
    return { routineId, runId: outcome.runId, rootExecutionId: run.executionId, outcome };
  }

  async function pendingApprovalFor(actionName: string): Promise<string> {
    const pending = await approvals.findPending();
    const match = pending.find(
      (row) => (row.payload as { actionName?: string } | null)?.actionName === actionName,
    );
    if (!match) throw new Error(`no pending approval for ${actionName}`);
    return match.id;
  }

  async function approve(approvalId: string) {
    await approvals.resolvePending(approvalId, "approve", "guardian");
    await handler.onApproved(approvalId);
  }

  async function reject(approvalId: string) {
    await approvals.resolvePending(approvalId, "reject", "guardian");
    await handler.onRejected(approvalId);
  }

  async function runStatus(runId: string) {
    return (await routineRuns.findById(runId))?.status;
  }

  it("takes the approved replay's outcome and stops blocking the routine's delete", async () => {
    const send = makeAction("send_report", ok, true);
    registry.register(send);
    const { routineId, runId, rootExecutionId, outcome } = await fire("send_report");
    expect(outcome.status).toBe("pending_approval");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toEqual({
      status: "active-runs",
      activeRuns: 1,
    });

    await approve(await pendingApprovalFor("send_report"));

    expect(send.calls).toBe(1);
    expect(await runStatus(runId)).toBe("success");
    // The replay resumed the parked root row rather than adding a second root.
    expect(
      (await executions.findByRootExecutionIds([rootExecutionId])).map((row) => [
        row.id,
        row.status,
      ]),
    ).toEqual([[rootExecutionId, "success"]]);
    expect((await routineRuns.findLatestByRoutineIds([routineId])).get(routineId)?.status).toBe(
      "success",
    );
    expect(await routines.deleteIfNoActiveRuns(routineId)).toEqual({
      status: "deleted",
      name: "nightly",
    });
  });

  it("ends cancelled with its root when the guardian rejects, with no session to resume", async () => {
    const send = makeAction("send_report", ok, true);
    registry.register(send);
    const { routineId, runId, rootExecutionId } = await fire("send_report");
    const approvalId = await pendingApprovalFor("send_report");
    expect((await approvals.findById(approvalId))?.payload).not.toHaveProperty("sessionId");

    await reject(approvalId);

    expect(send.calls).toBe(0);
    expect(await runStatus(runId)).toBe("cancelled");
    const root = await executions.findById(rootExecutionId);
    expect(root?.status).toBe("cancelled");
    expect(root?.finishedAt).toBeInstanceOf(Date);
    expect(await routines.deleteIfNoActiveRuns(routineId)).toEqual({
      status: "deleted",
      name: "nightly",
    });
  });

  // Approving the second call of such a chain does not run it yet: the replay
  // journal records the first call twice, so the replay diverges. The run
  // contract here holds either way, so this test stops at a rejection.
  it("stays parked while an approved replay parks on the next gated call", async () => {
    const gateA = makeAction("gate_a", ok, true);
    const gateB = makeAction("gate_b", ok, true);
    registry.register(gateA);
    registry.register(gateB);
    registry.register(
      makeAction("sync", async () => {
        const a = await engine.run("gate_a", {});
        if (a.status === "pending_approval") return a;
        return engine.run("gate_b", {});
      }),
    );
    const { routineId, runId, rootExecutionId } = await fire("sync");

    await approve(await pendingApprovalFor("gate_a"));

    expect(gateA.calls).toBe(1);
    expect(await runStatus(runId)).toBe("pending_approval");
    expect((await executions.findById(rootExecutionId))?.status).toBe("pending_approval");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({
      status: "active-runs",
    });

    await reject(await pendingApprovalFor("gate_b"));

    expect(gateB.calls).toBe(0);
    expect(await runStatus(runId)).toBe("cancelled");
    expect((await executions.findById(rootExecutionId))?.status).toBe("cancelled");
  });

  it("stays parked when one of two approvals on its root is rejected", async () => {
    registry.register(makeAction("gate_a", ok, true));
    registry.register(makeAction("gate_b", ok, true));
    registry.register(
      makeAction("sync", async () => {
        await engine.run("gate_a", {});
        return engine.run("gate_b", {});
      }),
    );
    const { routineId, runId, rootExecutionId } = await fire("sync");
    const approvalB = await pendingApprovalFor("gate_b");

    await reject(await pendingApprovalFor("gate_a"));

    expect(await runStatus(runId)).toBe("pending_approval");
    expect((await executions.findById(rootExecutionId))?.status).toBe("pending_approval");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({
      status: "active-runs",
    });

    await reject(approvalB);

    expect(await runStatus(runId)).toBe("cancelled");
    expect((await executions.findById(rootExecutionId))?.status).toBe("cancelled");
  });

  it("records a thrown replay as an error and a successful retry as success", async () => {
    let attempts = 0;
    registry.register(
      makeAction(
        "export",
        async () => {
          attempts++;
          if (attempts === 1) throw new Error("export target unavailable");
          return { status: "ok" };
        },
        true,
      ),
    );
    const { routineId, runId } = await fire("export");
    const approvalId = await pendingApprovalFor("export");

    await approve(approvalId);

    const failed = await routineRuns.findById(runId);
    expect(failed?.status).toBe("error");
    expect(failed?.error).toContain("export target unavailable");
    expect((await approvals.findById(approvalId))?.executionState).toBe("failed");

    expect((await approvals.retryFailedExecution(approvalId)).outcome).toBe("queued");
    await handler.onApproved(approvalId);

    const retried = await routineRuns.findById(runId);
    expect(retried?.status).toBe("success");
    expect(retried?.error).toBeUndefined();
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({ status: "deleted" });
  });

  it("records an error when the approved action is gone before its replay", async () => {
    registry.register(makeAction("send_report", ok, true));
    const { routineId, runId, rootExecutionId } = await fire("send_report");
    const approvalId = await pendingApprovalFor("send_report");
    registry.unregister("send_report");

    await approve(approvalId);

    expect(await runStatus(runId)).toBe("error");
    expect((await executions.findById(rootExecutionId))?.status).toBe("error");
    expect((await approvals.findById(approvalId))?.executionState).toBe("failed");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({ status: "deleted" });
  });

  it("waits again when a retried replay parks on the next gated call", async () => {
    let attempts = 0;
    registry.register(makeAction("gate_a", ok, true));
    const gateB = makeAction("gate_b", ok, true);
    registry.register(gateB);
    registry.register(
      makeAction("sync", async () => {
        const a = await engine.run("gate_a", {});
        if (a.status === "pending_approval") return a;
        attempts++;
        if (attempts === 1) throw new Error("export target unavailable");
        return engine.run("gate_b", {});
      }),
    );
    const { routineId, runId, rootExecutionId } = await fire("sync");
    const approvalA = await pendingApprovalFor("gate_a");
    await approve(approvalA);
    expect(await runStatus(runId)).toBe("error");

    expect((await approvals.retryFailedExecution(approvalA)).outcome).toBe("queued");
    await handler.onApproved(approvalA);

    expect(await runStatus(runId)).toBe("pending_approval");
    expect((await executions.findById(rootExecutionId))?.status).toBe("pending_approval");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({
      status: "active-runs",
    });

    await reject(await pendingApprovalFor("gate_b"));

    expect(gateB.calls).toBe(0);
    expect(await runStatus(runId)).toBe("cancelled");
  });

  it("ends cancelled when the root ignored the pending result of a rejected call", async () => {
    const gate = makeAction("gate", ok, true);
    registry.register(gate);
    registry.register(
      makeAction("sync", async () => {
        await engine.run("gate", {});
        return { status: "ok" };
      }),
    );
    const { runId, rootExecutionId, outcome } = await fire("sync");
    expect(outcome.status).toBe("pending_approval");
    expect((await executions.findById(rootExecutionId))?.status).toBe("pending_approval");

    await reject(await pendingApprovalFor("gate"));

    expect(gate.calls).toBe(0);
    expect(await runStatus(runId)).toBe("cancelled");
    expect((await executions.findById(rootExecutionId))?.status).toBe("cancelled");
  });

  // A stop during the continuation then leaves nothing that a retry would run
  // a second time.
  it("records the approved action as executed before the agent continues", async () => {
    registry.register(makeAction("send_report", ok, true));
    await fire("send_report");
    const fired = (await approvals.findById(await pendingApprovalFor("send_report")))!;
    const withSession = await approvals.create({
      type: "action_execution",
      requestedBy: fired.requestedBy,
      description: fired.description,
      payload: { ...(fired.payload as Record<string, unknown>), sessionId: "session-1" },
    });
    await approvals.resolvePending(withSession, "approve", "guardian");
    const statesDuringContinuation: unknown[] = [];
    const base = createMockAgentRunner();
    const agentRunner = {
      ...base,
      async *run(params: Parameters<typeof base.run>[0]) {
        statesDuringContinuation.push((await approvals.findById(withSession))?.executionState);
        yield* base.run(params);
      },
    };
    const continuing = new ApprovalHandler(
      approvals,
      new ExecutionJournalRepository(testDb.db),
      engine,
      agentRunner,
      createBackendTurnRunner({ agentRunner, channel: () => null }),
    );

    await continuing.onApproved(withSession);

    expect(statesDuringContinuation).toEqual(["succeeded"]);
  });

  it("keeps the approval executed when only the agent continuation fails", async () => {
    const send = makeAction("send_report", ok, true);
    registry.register(send);
    await fire("send_report");
    const parked = (await approvals.findById(await pendingApprovalFor("send_report")))!;
    const withSession = await approvals.create({
      type: "action_execution",
      requestedBy: parked.requestedBy,
      description: parked.description,
      payload: { ...(parked.payload as Record<string, unknown>), sessionId: "session-1" },
    });
    await approvals.resolvePending(withSession, "approve", "guardian");
    const base = createMockAgentRunner();
    const agentRunner = {
      ...base,
      async *run(params: Parameters<typeof base.run>[0]) {
        yield* base.run(params);
        throw new Error("model unavailable");
      },
    };
    const continuing = new ApprovalHandler(
      approvals,
      new ExecutionJournalRepository(testDb.db),
      engine,
      agentRunner,
      createBackendTurnRunner({ agentRunner, channel: () => null }),
    );

    await continuing.onApproved(withSession);

    expect(send.calls).toBe(1);
    expect((await approvals.findById(withSession))?.executionState).toBe("succeeded");
    expect((await approvals.retryFailedExecution(withSession)).outcome).toBe("not_retryable");
  });

  // The guardian resolves the approval while the run that requested it is
  // still announcing it. The resolution runs outside the announcing call, as
  // a request from the dashboard would.
  function holdAnnouncement() {
    const approvalAnnounced = deferred<string>();
    const announcing = deferred();
    whileAnnouncingApproval = async (approvalId) => {
      approvalAnnounced.resolve(approvalId);
      await announcing.promise;
    };
    return { approvalAnnounced: approvalAnnounced.promise, finishAnnouncing: announcing.resolve };
  }

  async function resolveWhileAnnouncing(actionName: string, decision: "approve" | "reject") {
    const { approvalAnnounced, finishAnnouncing } = holdAnnouncement();
    const firing = fire(actionName);
    const approvalId = await approvalAnnounced;
    if (decision === "approve") await approve(approvalId);
    else await reject(approvalId);
    finishAnnouncing();
    return firing;
  }

  // A gated root parks before its row exists. A root whose nested call is
  // gated has a running row while the approval is announced.
  for (const gated of ["root", "nested"] as const) {
    function register() {
      const gate = makeAction("gate", ok, true);
      registry.register(gate);
      registry.register(makeAction("sync", async () => engine.run("gate", {})));
      return { gate, rootAction: gated === "root" ? "gate" : "sync" };
    }

    it(`takes the outcome of an approval resolved while a ${gated}-gated run parks`, async () => {
      const { gate, rootAction } = register();

      const { runId, rootExecutionId } = await resolveWhileAnnouncing(rootAction, "approve");

      expect(gate.calls).toBe(1);
      expect(await runStatus(runId)).toBe("success");
      expect((await executions.findById(rootExecutionId))?.status).toBe("success");
    });

    it(`ends cancelled when rejected while a ${gated}-gated run parks`, async () => {
      const { gate, rootAction } = register();

      const { runId, rootExecutionId } = await resolveWhileAnnouncing(rootAction, "reject");

      expect(gate.calls).toBe(0);
      expect(await runStatus(runId)).toBe("cancelled");
      expect((await executions.findById(rootExecutionId))?.status).toBe("cancelled");
    });
  }

  // The run that requested the approval parks the root after its replay
  // started, as it can from another action worker. A stop during the replay
  // then leaves a parked root, not a running one.
  it("ends a root its run parked over a replay a stop interrupted", async () => {
    const gateRunning = deferred();
    const gateReleased = deferred();
    registry.register(
      makeAction(
        "gate",
        async () => {
          gateRunning.resolve();
          await gateReleased.promise;
          return { status: "ok" };
        },
        true,
      ),
    );
    registry.register(makeAction("sync", async () => engine.run("gate", {})));
    const { approvalAnnounced, finishAnnouncing } = holdAnnouncement();
    const firing = fire("sync");
    const approvalId = await approvalAnnounced;
    await approvals.resolvePending(approvalId, "approve", "guardian");
    const replaying = handler.onApproved(approvalId);
    await gateRunning.promise;

    finishAnnouncing();
    const { routineId, runId, rootExecutionId } = await firing;
    expect((await executions.findById(rootExecutionId))?.status).toBe("pending_approval");

    // The next start, with the replay cut off.
    await recoverInterruptedApprovals({ approvals, executions }, new Date());
    await settleResolvedParkedRuns({ executions, approvals, routineRuns }, new Date());

    expect((await executions.findById(rootExecutionId))?.status).toBe("error");
    expect(await runStatus(runId)).toBe("error");
    expect((await approvals.findById(approvalId))?.executionState).toBe("failed");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({ status: "deleted" });
    gateReleased.resolve();
    await replaying;
  });

  it("keeps a run active while the retry of a stopped replay runs", async () => {
    let attempts = 0;
    const retryRunning = deferred();
    const retryReleased = deferred();
    registry.register(
      makeAction(
        "export",
        async () => {
          attempts++;
          if (attempts === 1) throw new ActionCancelledError("Cancelled by user");
          retryRunning.resolve();
          await retryReleased.promise;
          return { status: "ok" };
        },
        true,
      ),
    );
    const { routineId, runId } = await fire("export");
    const approvalId = await pendingApprovalFor("export");
    await approve(approvalId);
    expect(await runStatus(runId)).toBe("cancelled");

    expect((await approvals.retryFailedExecution(approvalId)).outcome).toBe("queued");
    const retrying = handler.onApproved(approvalId);
    await retryRunning.promise;

    expect(await runStatus(runId)).toBe("pending_approval");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({
      status: "active-runs",
    });
    retryReleased.resolve();
    await retrying;
    expect(await runStatus(runId)).toBe("success");
  });

  it("reopens a failed run when its retry is claimed, before the retry waits its turn", async () => {
    let attempts = 0;
    registry.register(
      makeAction(
        "export",
        async () => {
          attempts++;
          if (attempts === 1) throw new Error("export target unavailable");
          return { status: "ok" };
        },
        true,
      ),
    );
    const { routineId, runId } = await fire("export");
    const approvalId = await pendingApprovalFor("export");
    await approve(approvalId);
    expect(await runStatus(runId)).toBe("error");
    const sessionQueued = deferred();
    const sessionFree = deferred();
    const agentRunner = createMockAgentRunner();
    const base = createBackendTurnRunner({ agentRunner, channel: () => null });
    const busySession = new ApprovalHandler(
      approvals,
      new ExecutionJournalRepository(testDb.db),
      engine,
      agentRunner,
      {
        ...base,
        runBackendSessionTask: async (channel, threadId, task) => {
          sessionQueued.resolve();
          await sessionFree.promise;
          return base.runBackendSessionTask(channel, threadId, task);
        },
      },
      undefined,
      { executions, ...routineRunApprovalHooks({ executions, approvals, routineRuns }) },
    );
    await approvals.retryFailedExecution(approvalId);

    const retrying = busySession.onApproved(approvalId);
    await sessionQueued.promise;

    expect(await runStatus(runId)).toBe("pending_approval");
    expect(await routines.deleteIfNoActiveRuns(routineId)).toMatchObject({
      status: "active-runs",
    });
    sessionFree.resolve();
    await retrying;
    expect(await runStatus(runId)).toBe("success");
  });

  // Two approvals that replay one root, as when two gated calls in one tree
  // are approved together. The second replay parks on a new gated call after
  // the first finished.
  it("replays one root in turn, so a finished replay cannot hide one that parks again", async () => {
    let bodies = 0;
    let running = 0;
    let overlapped = false;
    const firstFinished = deferred();
    registry.register(makeAction("gate_b", ok, true));
    registry.register(
      makeAction(
        "send_report",
        async () => {
          bodies++;
          running++;
          if (running > 1) overlapped = true;
          try {
            if (bodies === 1) return { status: "ok" };
            await firstFinished.promise;
            // Long enough for the first replay to record its outcome.
            await new Promise((resolve) => setTimeout(resolve, 20));
            return await engine.run("gate_b", {});
          } finally {
            running--;
            if (bodies === 1) firstFinished.resolve();
          }
        },
        true,
      ),
    );
    const { runId, rootExecutionId } = await fire("send_report");
    const first = (await approvals.findById(await pendingApprovalFor("send_report")))!;
    const second = await approvals.create({
      type: "action_execution",
      requestedBy: first.requestedBy,
      description: first.description,
      payload: first.payload as Record<string, unknown>,
    });
    await approvals.resolvePending(first.id, "approve", "guardian");
    await approvals.resolvePending(second, "approve", "guardian");

    await Promise.all([handler.onApproved(first.id), handler.onApproved(second)]);

    expect(overlapped).toBe(false);
    expect((await executions.findById(rootExecutionId))?.status).toBe("pending_approval");
    expect(await runStatus(runId)).toBe("pending_approval");

    await reject(await pendingApprovalFor("gate_b"));

    expect(await runStatus(runId)).toBe("cancelled");
  });
});

describe("settleResolvedParkedRuns", () => {
  let testDb: TestDb;
  let approvals: ApprovalsRepository;
  let executions: ActionExecutionsRepository;
  let routines: RoutinesRepository;
  let routineRuns: RoutineRunsRepository;
  const boot = new Date("2026-10-08T12:00:00Z");

  beforeEach(() => {
    testDb = createTestDb();
    approvals = new ApprovalsRepository(testDb.db);
    executions = new ActionExecutionsRepository(testDb.db);
    routines = new RoutinesRepository(testDb.db);
    routineRuns = new RoutineRunsRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  // The boot sequence after endInterruptedRuns.
  async function bootPass() {
    await recoverInterruptedApprovals({ approvals, executions }, boot);
    return settleResolvedParkedRuns({ executions, approvals, routineRuns }, boot);
  }

  // A run parked before Rome settled parked runs on resolution, as on an
  // instance upgraded with one already stuck.
  async function seedParkedRun(name: string, decision: "approve" | "reject" | null) {
    const routineId = await routines.create({
      name,
      trigger: { type: "manual" },
      actionName: "code-review:sync",
      args: {},
    });
    const rootExecutionId = `root-${name}`;
    const runId = await routineRuns.create({
      routineId,
      executionId: rootExecutionId,
      status: "pending_approval",
    });
    await executions.create({
      id: rootExecutionId,
      actionName: "code-review:sync",
      status: "pending_approval",
    });
    const approvalId = await approvals.create({
      type: "action_execution",
      requestedBy: `routine:${name}`,
      description: "Action requires guardian approval",
      payload: { actionName: "code-review:sync", rootExecutionId },
    });
    if (decision) await approvals.resolvePending(approvalId, decision, "guardian");
    return { routineId, runId, rootExecutionId };
  }

  it("cancels a run whose root was rejected and keeps one still awaiting the guardian", async () => {
    const rejected = await seedParkedRun("rejected", "reject");
    const waiting = await seedParkedRun("waiting", null);
    // Approved but not yet executed: the replay can still run.
    const queued = await seedParkedRun("queued", "approve");

    expect(await bootPass()).toBe(1);

    expect((await routineRuns.findById(rejected.runId))?.status).toBe("cancelled");
    const root = await executions.findById(rejected.rootExecutionId);
    expect(root?.status).toBe("cancelled");
    expect(root?.finishedAt).toEqual(boot);
    expect(await routines.deleteIfNoActiveRuns(rejected.routineId)).toMatchObject({
      status: "deleted",
    });

    for (const run of [waiting, queued]) {
      expect((await routineRuns.findById(run.runId))?.status).toBe("pending_approval");
      expect((await executions.findById(run.rootExecutionId))?.status).toBe("pending_approval");
    }
  });

  it("finds the root of a run fired before its root row took the run's execution id", async () => {
    const routineId = await routines.create({
      name: "legacy",
      trigger: { type: "manual" },
      actionName: "code-review:sync",
      args: {},
    });
    const runId = await routineRuns.create({
      routineId,
      executionId: "tree-legacy",
      status: "pending_approval",
    });
    await executions.create({
      id: "row-legacy",
      rootExecutionId: "tree-legacy",
      actionName: "code-review:sync",
      status: "pending_approval",
    });
    const approvalId = await approvals.create({
      type: "action_execution",
      requestedBy: "routine:legacy",
      description: "Action requires guardian approval",
      payload: { actionName: "code-review:sync", rootExecutionId: "tree-legacy" },
    });
    await approvals.resolvePending(approvalId, "reject", "guardian");

    expect(await bootPass()).toBe(1);

    expect((await routineRuns.findById(runId))?.status).toBe("cancelled");
    expect((await executions.findById("row-legacy"))?.status).toBe("cancelled");
  });

  it("fails an approved replay a stop interrupted and copies its root's error", async () => {
    const interrupted = await seedParkedRun("interrupted", "approve");
    const [approval] = await approvals.findByType("action_execution");
    expect(await approvals.claimExecution(approval!.id)).toBe(true);
    // As endInterruptedRuns leaves the root the replay was running.
    await executions.update(interrupted.rootExecutionId, {
      status: "error",
      error: "Rome stopped while this was running",
    });

    expect(await bootPass()).toBe(1);

    const run = await routineRuns.findById(interrupted.runId);
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("Rome stopped while this was running");
    expect(await approvals.findById(approval!.id)).toMatchObject({
      executionState: "failed",
      executionError: "Rome stopped while the approved action was running",
    });
    expect(await routines.deleteIfNoActiveRuns(interrupted.routineId)).toMatchObject({
      status: "deleted",
    });
    // Failed, the approval is retryable again; `running` never was.
    expect(await approvals.retryFailedExecution(approval!.id)).toMatchObject({
      outcome: "queued",
    });
  });

  it("keeps a root parked when its interrupted replay had parked it on a new approval", async () => {
    const reparked = await seedParkedRun("reparked", "approve");
    const [approval] = await approvals.findByType("action_execution");
    await approvals.claimExecution(approval!.id);
    await approvals.create({
      type: "action_execution",
      requestedBy: "routine:reparked",
      description: "Action requires guardian approval",
      payload: { actionName: "code-review:post", rootExecutionId: reparked.rootExecutionId },
    });

    expect(await bootPass()).toBe(0);

    expect((await executions.findById(reparked.rootExecutionId))?.status).toBe("pending_approval");
    expect((await routineRuns.findById(reparked.runId))?.status).toBe("pending_approval");
  });

  it("makes an approval a stop left unclaimed retryable and keeps its run waiting", async () => {
    const unclaimed = await seedParkedRun("unclaimed", "approve");
    const [approval] = await approvals.findByType("action_execution");

    expect(await bootPass()).toBe(0);

    expect((await routineRuns.findById(unclaimed.runId))?.status).toBe("pending_approval");
    expect(await approvals.findById(approval!.id)).toMatchObject({
      executionState: "failed",
      executionError: "Rome stopped before the approved action started",
    });
    expect(await approvals.retryFailedExecution(approval!.id)).toMatchObject({
      outcome: "queued",
    });
  });

  it("copies the outcome of a root whose approved replay finished", async () => {
    const done = await seedParkedRun("done", "approve");
    const [approval] = await approvals.findByType("action_execution");
    await approvals.markExecuted(approval!.id);
    await executions.update(done.rootExecutionId, { status: "error", error: "upstream 500" });

    expect(await bootPass()).toBe(1);

    const run = await routineRuns.findById(done.runId);
    expect(run?.status).toBe("error");
    expect(run?.error).toBe("upstream 500");
  });

  // A replay that threw before Rome settled parked runs, or one a stop cut off
  // between failing the approval and settling the run.
  it("copies the error of a root whose approved replay already failed", async () => {
    const failed = await seedParkedRun("failed", "approve");
    const [approval] = await approvals.findByType("action_execution");
    await approvals.claimExecution(approval!.id);
    await approvals.markExecutionFailed(approval!.id, "upstream 500");
    await executions.update(failed.rootExecutionId, { status: "error", error: "upstream 500" });

    expect(await bootPass()).toBe(1);

    expect(await routineRuns.findById(failed.runId)).toMatchObject({
      status: "error",
      error: "upstream 500",
    });
    expect(await routines.deleteIfNoActiveRuns(failed.routineId)).toMatchObject({
      status: "deleted",
    });
  });
});
