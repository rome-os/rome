import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { deliverWebhookCallbacks } from "../api/webhook-callbacks.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { WebhookInvocationsRepository } from "../db/repositories/webhook-invocations.js";
import { hostJobId } from "../host-execution/service.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import {
  endInterruptedRuns,
  endInterruptedWebhookInvocations,
  INTERRUPTED_EXECUTION_ERROR,
  INTERRUPTED_ROUTINE_RUN_ERROR,
} from "./restart-recovery.js";

const lastWeek = new Date("2026-10-01T09:00:00Z");
const boot = new Date("2026-10-08T12:00:00Z");

describe("endInterruptedRuns", () => {
  let testDb: TestDb;
  let executions: ActionExecutionsRepository;
  let routineRuns: RoutineRunsRepository;
  let routines: RoutinesRepository;

  beforeEach(() => {
    testDb = createTestDb();
    executions = new ActionExecutionsRepository(testDb.db);
    routineRuns = new RoutineRunsRepository(testDb.db);
    routines = new RoutinesRepository(testDb.db);
  });

  afterEach(() => {
    testDb.close();
  });

  function seedRoutine(name: string): Promise<string> {
    return routines.create({
      name,
      key: name,
      managedBy: "code-review",
      trigger: { type: "manual" },
      actionName: "code-review:sync",
      args: {},
    });
  }

  // A routine whose last run died with the process stays undeletable until the
  // run is ended, which blocks an app's delete-and-recreate migration.
  it("unblocks deleting a routine whose run a stopped process left running", async () => {
    const routineId = await seedRoutine("sync");
    await routineRuns.create({ routineId, executionId: "root", status: "running" });
    await executions.create({
      id: "root",
      actionName: "code-review:sync",
      status: "running",
      startedAt: lastWeek,
    });
    expect(await routines.deleteIfNoActiveRuns(routineId, "code-review")).toEqual({
      status: "active-runs",
      activeRuns: 1,
    });

    expect(await endInterruptedRuns({ executions, routineRuns }, boot)).toEqual({
      executions: 1,
      routineRuns: 1,
    });

    expect(await routines.deleteIfNoActiveRuns(routineId, "code-review")).toEqual({
      status: "deleted",
      name: "sync",
    });
  });

  it("ends every running execution in a tree and keeps finished and pending ones", async () => {
    await executions.create({
      id: "root",
      actionName: "code-review:sync",
      status: "running",
      startedAt: lastWeek,
    });
    await executions.create({
      id: "child-running",
      rootExecutionId: "root",
      parentId: "root",
      actionName: "system:search_routine",
      status: "running",
      startedAt: lastWeek,
    });
    await executions.create({
      id: "child-done",
      rootExecutionId: "root",
      parentId: "root",
      actionName: "system:search_routine",
      status: "success",
      startedAt: lastWeek,
      finishedAt: lastWeek,
    });
    await executions.create({
      id: "awaiting-approval",
      actionName: "system:send_message",
      status: "pending_approval",
      startedAt: lastWeek,
    });

    expect(await endInterruptedRuns({ executions, routineRuns }, boot)).toEqual({
      executions: 2,
      routineRuns: 0,
    });

    for (const id of ["root", "child-running"]) {
      expect(await executions.findById(id)).toMatchObject({
        status: "error",
        error: INTERRUPTED_EXECUTION_ERROR,
        finishedAt: boot,
      });
    }
    expect(await executions.findById("child-done")).toMatchObject({
      status: "success",
      error: null,
      finishedAt: lastWeek,
    });
    expect(await executions.findById("awaiting-approval")).toMatchObject({
      status: "pending_approval",
      finishedAt: null,
    });
  });

  // A host job outlives Rome, so the record must not read as a script that never ran.
  it("names the host job of an interrupted root script so it can be inspected", async () => {
    await executions.create({
      id: "host-exec",
      actionName: "system:execute_root_script",
      status: "running",
      startedAt: lastWeek,
    });

    await endInterruptedRuns({ executions, routineRuns }, boot);

    const row = await executions.findById("host-exec");
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("Host submission outcome is unknown");
    expect(row?.error).toContain(`Inspect job ${hostJobId("host-exec")}`);
    expect(row?.error).toContain("system:manage_root_script");
  });

  // An approval outlives a restart, so a run parked on one stays active and keeps
  // its routine from being deleted.
  it("keeps a routine run that awaits approval", async () => {
    const routineId = await seedRoutine("digest");
    await routineRuns.create({ routineId, executionId: "parked", status: "pending_approval" });
    await routineRuns.create({ routineId, executionId: "died", status: "running" });
    await routineRuns.create({ routineId, executionId: "done", status: "success" });

    expect(await endInterruptedRuns({ executions, routineRuns }, boot)).toEqual({
      executions: 0,
      routineRuns: 1,
    });

    const byExecution = new Map(
      (await routineRuns.findByRoutineId(routineId)).map((run) => [run.executionId, run]),
    );
    expect(byExecution.get("parked")?.status).toBe("pending_approval");
    expect(byExecution.get("died")).toMatchObject({
      status: "error",
      error: INTERRUPTED_ROUTINE_RUN_ERROR,
    });
    expect(byExecution.get("done")?.status).toBe("success");
    expect(await routines.deleteIfNoActiveRuns(routineId, "code-review")).toEqual({
      status: "active-runs",
      activeRuns: 1,
    });
  });
});

describe("endInterruptedWebhookInvocations", () => {
  const callbackUrl = "https://hooks.example.test/rome-callback";
  let testDb: TestDb;
  let executions: ActionExecutionsRepository;
  let routineRuns: RoutineRunsRepository;
  let webhookInvocations: WebhookInvocationsRepository;

  beforeEach(() => {
    testDb = createTestDb();
    executions = new ActionExecutionsRepository(testDb.db);
    routineRuns = new RoutineRunsRepository(testDb.db);
    webhookInvocations = new WebhookInvocationsRepository(testDb.db);
  });

  afterEach(() => {
    rs.restoreAllMocks();
    testDb.close();
  });

  // The boot order in index.ts: executions end first, so a webhook row reads
  // its execution's final outcome.
  async function restart(): Promise<number> {
    await endInterruptedRuns({ executions, routineRuns }, boot);
    return endInterruptedWebhookInvocations({ webhookInvocations, executions }, boot);
  }

  async function seedInvocation(
    executionId: string,
    status: "accepted" | "running",
    options: { callbackUrl?: string } = {},
  ): Promise<void> {
    await webhookInvocations.createAccepted({
      executionId,
      actionName: "code-review:sync",
      args: {},
      callbackUrl: options.callbackUrl,
      createdAt: lastWeek,
    });
    if (status === "running") await webhookInvocations.update(executionId, { status });
  }

  // Without the sweep, GET /webhooks/executions/:id reads `running` forever
  // while the execution with the same id reads `error`.
  it("records an invocation a stopped process left accepted or running as interrupted", async () => {
    await seedInvocation("mid-run", "running");
    await executions.create({
      id: "mid-run",
      actionName: "code-review:sync",
      status: "running",
      startedAt: lastWeek,
    });
    // Rome stopped between accepting the request and starting the execution.
    await seedInvocation("never-started", "accepted");

    expect(await restart()).toBe(2);

    for (const id of ["mid-run", "never-started"]) {
      expect(await webhookInvocations.findByExecutionId(id)).toMatchObject({
        status: "error",
        error: INTERRUPTED_EXECUTION_ERROR,
        result: null,
        finishedAt: boot,
      });
    }
    expect((await executions.findById("mid-run"))?.status).toBe("error");
  });

  // The execution finished before the stop, but its webhook row was never updated.
  it("copies the outcome of an execution that finished before Rome stopped", async () => {
    await seedInvocation("finished", "running");
    await executions.create({
      id: "finished",
      actionName: "code-review:sync",
      status: "success",
      startedAt: lastWeek,
      finishedAt: lastWeek,
    });

    expect(await restart()).toBe(1);

    expect(await webhookInvocations.findByExecutionId("finished")).toMatchObject({
      status: "success",
      error: null,
      finishedAt: lastWeek,
    });
  });

  it("keeps an execution awaiting approval visible and leaves settled invocations alone", async () => {
    await seedInvocation("parked", "running");
    await executions.create({
      id: "parked",
      actionName: "code-review:sync",
      status: "pending_approval",
      startedAt: lastWeek,
    });
    await seedInvocation("settled", "running");
    await webhookInvocations.update("settled", {
      status: "cancelled",
      error: "cancelled by the guardian",
      finishedAt: lastWeek,
    });

    expect(await restart()).toBe(1);

    expect(await webhookInvocations.findByExecutionId("parked")).toMatchObject({
      status: "pending_approval",
      error: null,
      finishedAt: boot,
    });
    expect(await webhookInvocations.findByExecutionId("settled")).toMatchObject({
      status: "cancelled",
      error: "cancelled by the guardian",
      finishedAt: lastWeek,
    });
  });

  it("delivers each callback a stopped process never sent, once", async () => {
    await seedInvocation("interrupted", "running", { callbackUrl });
    await seedInvocation("no-callback", "running");
    const fetchSpy = rs
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));

    await restart();
    await deliverWebhookCallbacks(
      webhookInvocations,
      await webhookInvocations.listUndeliveredCallbacks(),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(callbackUrl);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      executionId: "interrupted",
      status: "error",
      error: INTERRUPTED_EXECUTION_ERROR,
      finishedAt: boot.toISOString(),
    });
    expect(await webhookInvocations.findByExecutionId("interrupted")).toMatchObject({
      callbackStatus: "succeeded",
      callbackResponseStatus: 204,
    });
    expect((await webhookInvocations.findByExecutionId("no-callback"))?.callbackStatus).toBe(
      "not_requested",
    );

    // The next start finds nothing left to deliver.
    await restart();
    await deliverWebhookCallbacks(
      webhookInvocations,
      await webhookInvocations.listUndeliveredCallbacks(),
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
