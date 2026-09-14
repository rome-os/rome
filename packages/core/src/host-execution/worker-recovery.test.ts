import { AsyncResource } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { createAction } from "../../../../rome_apps/system/src/actions/execute-root-script/index.js";
import { ActionCancelledError } from "../actions/action-errors.js";
import { ActionEngine } from "../actions/engine.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import type { ActionResult } from "../actions/types.js";
import { isActionWorkerPayload } from "../actions/worker-protocol.js";
import { ActionExecutionsRepository } from "../db/repositories/action-executions.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import { RoutinesRepository, toRoutine } from "../db/repositories/routines.js";
import { RoutineEngine } from "../routines/engine.js";
import { createTestDb } from "../test/helpers.js";
import { buildAction, FakeClock } from "../test/kit/index.js";
import { HostExecutionService } from "./service.js";
import { createHostWorkerRecovery } from "./worker-recovery.js";

const input = { target: "hosting-vm", interpreter: "sh", script: "printf hello", reason: "test" };
const actionName = "system:execute_root_script";
const jobId = (executionId: string) => createHash("sha256").update(executionId).digest("hex");
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(nested = false, signal: NodeJS.Signals | null = null, cancel = false) {
  const testDb = createTestDb();
  cleanup.push(() => testDb.close());
  const repo = new ActionExecutionsRepository(testDb.db);
  const clock = new FakeClock();
  const submissions: Array<Record<string, string>> = [];
  const directory = await mkdtemp("/tmp/rome-worker-job-");
  const socketPath = join(directory, "control.sock");
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/capabilities") {
      response.end(
        JSON.stringify({
          protocolVersion: 1,
          version: "1",
          hostId: "host-1",
          platform: "linux",
          enabled: true,
          interpreters: ["sh"],
          maxTimeoutSeconds: 600,
          maxOutputBytes: 4096,
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    submissions.push(body);
    response.end(
      JSON.stringify({
        id: body.requestId,
        requestId: body.requestId,
        hostId: "host-1",
        scriptSha256: createHash("sha256").update(body.script).digest("hex"),
        status: "succeeded",
        exitCode: 0,
        stdout: "hello",
        stderr: "",
        truncated: false,
        startedAt: "2026-01-01T00:00:00Z",
        finishedAt: "2026-01-01T00:00:01Z",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const registry = new ActionRegistryImpl([]);
  const hostAction = createAction(buildAction(actionName, { cancellable: false }).config, {
    hostExecution: new HostExecutionService({ enabled: true, socketPath }),
  });
  let child: EventEmitter & {
    connected: boolean;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  let engine: ActionEngine;
  async function loseWorker(): Promise<ActionResult> {
    if (cancel) {
      Object.assign(child, { pid: 999999 });
      const kill = rs.spyOn(process, "kill").mockReturnValue(true);
      cleanup.push(() => {
        kill.mockRestore();
      });
      await engine.cancel("root-1");
    }
    child.connected = false;
    child.exitCode = signal ? null : 1;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
    return new Promise(() => {});
  }
  registry.register(
    nested
      ? hostAction
      : {
          ...hostAction,
          execute: async (args, context) => {
            const result = await hostAction.execute(args, context);
            if (result.status === "error") return result;
            return loseWorker();
          },
        },
  );
  const workerEngine = new ActionEngine(registry, undefined, repo);
  if (nested)
    registry.register(
      buildAction("app:parent", {
        execute: async () => {
          await workerEngine.run(actionName, input);
          return loseWorker();
        },
      }),
    );
  const isolatedWorker = new AsyncResource("host-worker-test");
  cleanup.push(() => {
    isolatedWorker.emitDestroy();
  });
  const fork = rs.fn(() => {
    child = Object.assign(new EventEmitter(), {
      connected: true,
      exitCode: null,
      signalCode: null,
    });
    Object.assign(child, {
      send(message: unknown, callback?: (error: Error | null) => void) {
        callback?.(null);
        if (isActionWorkerPayload(message)) {
          isolatedWorker.runInAsyncScope(() => {
            void workerEngine.run(message.actionName, message.args, message.context).then(
              (result) => child.emit("message", { type: "result", result }),
              (error) =>
                child.emit("message", {
                  type: "error",
                  error: { name: error.name, message: error.message },
                }),
            );
          });
        }
        return true;
      },
    });
    return child as unknown as ChildProcess;
  });
  engine = new ActionEngine(registry, undefined, repo, undefined, undefined, {
    processRole: "main",
    workerWarmPoolSize: 0,
    clock,
    actionWorkerFork: fork,
    onWorkerInterrupted: createHostWorkerRecovery(repo),
  });
  return {
    engine,
    repo,
    clock,
    submissions,
    fork,
    db: testDb.db,
    name: nested ? "app:parent" : actionName,
  };
}

describe("host jobs after action worker loss", () => {
  it.each([
    null,
    "SIGKILL",
  ] as const)("returns the original receipt after acceptance and worker exit (%s)", async (signal) => {
    const { engine, repo, submissions, name } = await setup(false, signal);
    const result = await engine.run(name, input, {
      executionId: "execution-1",
      rootExecutionId: "root-1",
    });
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining(jobId("execution-1")),
    });
    expect(result).toMatchObject({ error: expect.stringContaining("system:manage_root_script") });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({
      requestId: jobId("execution-1"),
      executionId: "execution-1",
      rootExecutionId: "root-1",
    });
    expect(await repo.findById("execution-1")).toMatchObject({ status: "error" });
  });

  it("retains a completed inline child's receipt when its parent worker dies", async () => {
    const { engine, repo, submissions, name } = await setup(true);
    const result = await engine.run(
      name,
      {},
      { executionId: "parent-1", rootExecutionId: "root-1" },
    );
    expect(submissions).toHaveLength(1);
    expect(result).toMatchObject({
      status: "error",
      error: expect.stringContaining(submissions[0]!.requestId),
    });
    expect(await repo.findById(submissions[0]!.executionId)).toMatchObject({
      status: "success",
      parentId: "parent-1",
    });
  });

  it("returns receipts through the delegated worker boundary", async () => {
    const { engine, submissions, name } = await setup(true);
    const delegated = engine.startDelegatedAction({
      actionName: name,
      args: {},
      context: {
        executionId: "delegated-parent",
        rootExecutionId: "root",
        parentExecutionId: "owner",
      },
    });
    expect(await delegated.result).toMatchObject({
      status: "error",
      error: expect.stringContaining(submissions[0]!.requestId),
    });
    expect(submissions).toHaveLength(1);
  });

  it.each([
    false,
    true,
  ])("does not automatically retry a triggered host routine after worker loss (persistence failure: %s)", async (persistenceFailure) => {
    const { engine, repo, clock, submissions, fork, db } = await setup();
    if (persistenceFailure)
      rs.spyOn(repo, "markRootErrored").mockRejectedValue(new Error("database unavailable"));
    const routines = new RoutinesRepository(db);
    const runs = new RoutineRunsRepository(db);
    const routineEngine = new RoutineEngine(routines, runs, engine, 100, clock);
    cleanup.push(() => routineEngine.stop());
    let fire!: (payload: Record<string, unknown>) => Promise<void>;
    routineEngine.registerProvider("event-bus", {
      type: "event-bus",
      activate: async (_routine, callback) => {
        fire = callback;
      },
      deactivate() {},
      isActive: () => true,
      stop() {},
    });
    const id = await routines.create({
      name: "host-maintenance",
      trigger: { type: "event-bus", eventName: "test" },
      actionName,
      args: input,
      enabled: true,
    });
    await routineEngine.activate(toRoutine((await routines.findById(id))!));
    await fire({ source: "trigger" });
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).not.toHaveProperty("__triggerPayload");
    expect((await runs.findByRoutineId(id))[0]).toMatchObject({
      status: "error",
      error: expect.stringContaining(submissions[0]!.requestId),
    });
    expect(clock.pendingTimerCount()).toBe(0);
    await clock.advance(1000);
    expect(fork).toHaveBeenCalledTimes(1);
    expect(submissions).toHaveLength(1);
  });

  it("preserves requested cancellation instead of returning a recovery result", async () => {
    const { engine, name } = await setup(false, "SIGTERM", true);
    await expect(engine.run(name, input, { executionId: "root-1" })).rejects.toBeInstanceOf(
      ActionCancelledError,
    );
  });

  it("restricts receipts to the interrupted subtree and preserves IDs if lookup fails", async () => {
    const { repo } = await setup();
    await repo.create({
      id: "host-child",
      rootExecutionId: "root",
      parentId: "parent",
      actionName,
      status: "success",
    });
    await repo.create({
      id: "sibling",
      rootExecutionId: "root",
      parentId: "root",
      actionName,
      status: "running",
    });
    await repo.create({ id: "unrelated", rootExecutionId: "other", actionName, status: "running" });
    const recover = createHostWorkerRecovery(repo);
    const invocation = { actionName: "app:parent", executionId: "parent", rootExecutionId: "root" };
    const error = new Error("worker lost");
    const result = await recover(invocation, error);
    expect(result).toMatchObject({ error: expect.stringContaining(jobId("host-child")) });
    expect(JSON.stringify(result)).not.toContain(jobId("sibling"));
    expect(JSON.stringify(result)).not.toContain(jobId("unrelated"));
    rs.spyOn(repo, "findByRootExecutionIds").mockRejectedValue(new Error("database unavailable"));
    expect(await recover({ ...invocation, actionName }, error)).toMatchObject({
      status: "error",
      error: expect.stringContaining(jobId("parent")),
    });
    expect(await recover(invocation, error)).toMatchObject({
      status: "error",
      error: expect.stringContaining("database unavailable"),
    });
  });
});
