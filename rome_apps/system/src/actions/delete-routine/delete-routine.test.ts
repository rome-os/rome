import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import {
  RoutinesRepository,
  toRoutine,
} from "../../../../../packages/core/src/db/repositories/routines.js";
import { RoutineRunsRepository } from "../../../../../packages/core/src/db/repositories/routine-runs.js";
// Importing the store also registers the current-action-context resolver, so
// `getCurrentActionContext()` in delete_routine reads whatever store we wrap in.
import { actionExecutionContext } from "../../../../../packages/core/src/actions/context.js";
import { RoutineEngine } from "../../../../../packages/core/src/routines/engine.js";
import { ScheduleTriggerProvider } from "../../../../../packages/core/src/routines/schedule-trigger-provider.js";
import type {
  RoutineRunStatus,
  ScheduleTrigger,
} from "../../../../../packages/core/src/routines/types.js";
import { FakeClock } from "../../../../../packages/core/src/test/kit/index.js";
import { createAction, deleteRoutine } from "./index.js";

let testDb: TestDb;

function repo(): RoutinesRepository {
  return new RoutinesRepository(testDb.db);
}

const dailyAt9: ScheduleTrigger = {
  type: "schedule",
  tzid: "UTC",
  tzMode: "fixed",
  localTime: "09:00",
  rrule: "FREQ=DAILY",
};

async function seedRoutine(name = "water reminder"): Promise<string> {
  return repo().create({
    name,
    trigger: dailyAt9,
    actionName: "send_message",
    args: { text: "drink water" },
  });
}

async function seedManagedRoutine(managedBy: string, name = "briefing morning"): Promise<string> {
  return repo().create({
    name,
    managedBy,
    trigger: dailyAt9,
    actionName: "send_message",
    args: { text: "brief" },
  });
}

/** Run `fn` as if invoked by app `callerAppId` via its app-context runAction —
 * the runtime signal delete_routine reads to authorize deleting a managed routine. */
function asApp<T>(callerAppId: string, fn: () => Promise<T>): Promise<T> {
  return actionExecutionContext.run(
    { executionId: "exec", rootExecutionId: "root", initiator: `app:${callerAppId}`, callerAppId },
    fn,
  );
}

async function seedRun(routineId: string, status: RoutineRunStatus): Promise<void> {
  await new RoutineRunsRepository(testDb.db).create({
    routineId,
    executionId: `exec-${status}`,
    status,
  });
}

/** Engine fake that records deactivations (optionally rejecting them), so
 * tests can assert the teardown contract without a live scheduler. */
function recordingEngine(opts: { failDeactivate?: boolean } = {}) {
  const deactivated: string[] = [];
  return {
    deactivated,
    async activate() {},
    async deactivate(routineId: string) {
      if (opts.failDeactivate) throw new Error("scheduler unavailable");
      deactivated.push(routineId);
    },
  };
}

/** A live engine wired to a real schedule provider on the shared test DB, so
 * teardown assertions observe the actual cron-job lifecycle, not a mock. */
function liveEngine(): { engine: RoutineEngine; provider: ScheduleTriggerProvider } {
  const routinesRepo = repo();
  const provider = new ScheduleTriggerProvider(routinesRepo);
  const engine = new RoutineEngine(
    routinesRepo,
    new RoutineRunsRepository(testDb.db),
    { run: rs.fn() } as never,
    0,
    new FakeClock(),
  );
  engine.registerProvider("schedule", provider);
  return { engine, provider };
}

const actionConfig: ActionConfig = {
  name: "delete_routine",
  type: "system",
  description: "Delete a routine",
  complexity: "simple",
  speed: "fast",
  reliability: "high",
  sideEffects: "write",
};

describe("deleteRoutine", () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it("deletes the routine and reports the name it removed", async () => {
    const id = await seedRoutine("water reminder");

    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: recordingEngine() },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(result.data).toEqual({ deleted: true, routineId: id, name: "water reminder" });
  });

  it("removes the row so the routine no longer exists", async () => {
    const id = await seedRoutine();

    await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: recordingEngine() },
    );

    expect(await repo().findById(id)).toBeNull();
  });

  it("reports failure for an unknown id and deletes nothing", async () => {
    await seedRoutine();
    const engine = recordingEngine();

    const result = await deleteRoutine(
      { routineId: "does-not-exist" },
      { routinesRepo: repo(), routineEngine: engine },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/search_routine/);
    expect(await repo().listRoutines()).toHaveLength(1);
    expect(engine.deactivated).toHaveLength(0);
  });

  it("refuses to delete a routine with a running run, and keeps the routine", async () => {
    const id = await seedRoutine();
    await seedRun(id, "running");

    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: recordingEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/active run/i);
    expect(await repo().findById(id)).not.toBeNull();
  });

  it("refuses to delete a routine with a run awaiting approval", async () => {
    const id = await seedRoutine();
    await seedRun(id, "pending_approval");

    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: recordingEngine() },
    );

    expect(result.status).toBe("error");
    expect(await repo().findById(id)).not.toBeNull();
  });

  it("does not tear down the live trigger when it refuses an active-run delete", async () => {
    const id = await seedRoutine();
    await seedRun(id, "running");
    const { engine, provider } = liveEngine();
    await engine.activate(toRoutine((await repo().findById(id))!));

    await deleteRoutine({ routineId: id }, { routinesRepo: repo(), routineEngine: engine });

    // Rejected delete must leave the still-present routine firing.
    expect(provider.isActive(id)).toBe(true);
    engine.stop();
  });

  it("deletes when every run is in a terminal state (success / error / cancelled)", async () => {
    const id = await seedRoutine();
    await seedRun(id, "success");
    await seedRun(id, "error");
    await seedRun(id, "cancelled");

    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: recordingEngine() },
    );

    expect(result.status).toBe("ok");
    expect(await repo().findById(id)).toBeNull();
  });

  it("tears down the live schedule so a deleted routine stops firing", async () => {
    const id = await seedRoutine();
    const { engine, provider } = liveEngine();
    await engine.activate(toRoutine((await repo().findById(id))!));
    expect(provider.isActive(id)).toBe(true);

    await deleteRoutine({ routineId: id }, { routinesRepo: repo(), routineEngine: engine });

    expect(provider.isActive(id)).toBe(false);
    expect(await repo().findById(id)).toBeNull();
    engine.stop();
  });

  it("calls routineEngine.deactivate with the routine id after a successful delete", async () => {
    const id = await seedRoutine();
    const engine = recordingEngine();

    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: engine },
    );

    expect(result.status).toBe("ok");
    expect(engine.deactivated).toEqual([id]);
    expect(await repo().findById(id)).toBeNull();
  });

  // Teardown is best-effort: once the row is gone, a failed deactivate must
  // not resurrect the routine or surface as an error to the user.
  it("still reports success when deactivate rejects (row is already gone)", async () => {
    const id = await seedRoutine();

    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: recordingEngine({ failDeactivate: true }) },
    );

    expect(result.status).toBe("ok");
    expect(await repo().findById(id)).toBeNull();
  });

  it("refuses to delete an app-managed routine for a non-app caller, and keeps it firing", async () => {
    const id = await seedManagedRoutine("briefing");
    const { engine, provider } = liveEngine();
    await engine.activate(toRoutine((await repo().findById(id))!));

    // No app context (agent/user/dashboard) → no callerAppId → refused.
    const result = await deleteRoutine(
      { routineId: id },
      { routinesRepo: repo(), routineEngine: engine },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/managed by the "briefing" app/);
    expect(await repo().findById(id)).not.toBeNull();
    // A refused delete must leave the managed routine still live.
    expect(provider.isActive(id)).toBe(true);
    engine.stop();
  });

  it("refuses to delete an app-managed routine when a different app is the caller", async () => {
    const id = await seedManagedRoutine("briefing");

    const result = await asApp("dream", () =>
      deleteRoutine({ routineId: id }, { routinesRepo: repo(), routineEngine: recordingEngine() }),
    );

    expect(result.status).toBe("error");
    expect(await repo().findById(id)).not.toBeNull();
  });

  it("lets the owning app delete its own managed routine (it is the caller)", async () => {
    const id = await seedManagedRoutine("briefing");
    const engine = recordingEngine();

    const result = await asApp("briefing", () =>
      deleteRoutine({ routineId: id }, { routinesRepo: repo(), routineEngine: engine }),
    );

    expect(result.status).toBe("ok");
    expect(await repo().findById(id)).toBeNull();
    expect(engine.deactivated).toEqual([id]);
  });

  // The deps bag is untyped at the wiring seam — a missing engine must fail
  // the action load at boot rather than leave deleted routines firing.
  it("createAction refuses to load without a routineEngine dep", () => {
    expect(() =>
      createAction(actionConfig, {
        routinesRepo: repo(),
      } as unknown as Parameters<typeof createAction>[1]),
    ).toThrow(/routineEngine/);
  });
});
