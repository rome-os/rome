import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { RoutineEngine } from "./engine.js";
import { runWithSessionActor } from "../access/session-actor.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { RoutinesRepository } from "../db/repositories/routines.js";
import { RoutineRunsRepository } from "../db/repositories/routine-runs.js";
import type { ActionEngine } from "../apps/actions/engine.js";
import { systemClock, type Clock } from "../lib/clock.js";
import type { TriggerProvider } from "./trigger-provider.js";
import type { Trigger } from "./types.js";
import { actionExecutionContext, type ActionExecutionStore } from "../apps/actions/context.js";
import { replayContext, type ReplayStore } from "../apps/actions/replay.js";
import { currentSessionId, runWithSession } from "../telemetry-context.js";

// reactivateFloating only touches routinesRepo + activate(); the other ctor
// deps are never reached, so stub them rather than stand up the whole engine.
function makeEngine(repo: RoutinesRepository): RoutineEngine {
  return new RoutineEngine(
    repo,
    {} as unknown as RoutineRunsRepository,
    {} as unknown as ActionEngine,
    0,
    {} as unknown as Clock,
  );
}

describe("RoutineEngine.reactivateFloating", () => {
  let testDb: TestDb;
  let repo: RoutinesRepository;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new RoutinesRepository(testDb.db);
  });

  afterEach(() => testDb.close());

  async function seed(name: string, trigger: Trigger, enabled = true): Promise<string> {
    return repo.create({ name, trigger, actionName: "noop", args: {}, enabled });
  }

  it("re-activates every non-fixed enabled schedule, leaving fixed/disabled/other alone", async () => {
    const floatingId = await seed("floating", {
      type: "schedule",
      tzid: "UTC",
      tzMode: "floating",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    });
    // Explicit fixed (absolute zone): the one schedule kind left untouched.
    await seed("fixed", {
      type: "schedule",
      tzid: "Asia/Tokyo",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    });
    // Disabled floating: not live, so not re-activated by this sweep.
    await seed(
      "disabled-floating",
      {
        type: "schedule",
        tzid: "UTC",
        tzMode: "floating",
        localTime: "09:00",
        rrule: "FREQ=DAILY",
      },
      false,
    );
    // Non-schedule trigger: irrelevant to timezone.
    await seed("eventbus", { type: "event-bus", eventName: "x.y" });

    const engine = makeEngine(repo);
    const activate = rs.spyOn(engine, "activate").mockResolvedValue();

    await engine.reactivateFloating();

    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][0].id).toBe(floatingId);
  });

  it("is a no-op when every schedule is explicitly fixed", async () => {
    await seed("fixed", {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    });
    const engine = makeEngine(repo);
    const activate = rs.spyOn(engine, "activate").mockResolvedValue();

    await engine.reactivateFloating();

    expect(activate).not.toHaveBeenCalled();
  });
});

describe("RoutineEngine run records", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it("records what fired each run: the trigger type, or run_now for a manual run", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const actionEngine = {
      run: async () => ({ status: "success", result: null }),
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 0, systemClock);
    let fire: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
    const provider: Pick<TriggerProvider, "activate" | "deactivate"> = {
      activate: async (_routine, onFire) => {
        fire = onFire;
      },
      deactivate: () => {},
    };
    engine.registerProvider("schedule", provider as TriggerProvider);
    const id = await routines.create({
      name: "digest",
      trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00" },
      actionName: "noop",
      args: {},
    });
    await engine.start();

    await fire?.({});
    await runWithSessionActor({ kind: "guardian", userId: "g", via: "cookie" }, () =>
      engine.runNow(id),
    );
    // Run now with no person pressing it: the agent, or a CLI over loopback.
    await engine.runNow(id);

    const recorded = await runs.findByRoutineId(id);
    const firedBy = await Promise.all(recorded.map((run) => runs.findFiredBy(run.executionId)));
    expect(firedBy.sort()).toEqual(["run_now", "run_now_background", "schedule"]);
  });
  it("tells its listeners once a run now settles, failed or not, with its run recorded", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const actionEngine = {
      run: async () => ({ status: "error", error: "boom" }),
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 0, systemClock);
    const id = await routines.create({
      name: "digest",
      trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00" },
      actionName: "noop",
      args: {},
    });
    const told: Array<{ id: string; runs: number }> = [];
    engine.onChange((changed) => {
      void runs
        .findByRoutineId(changed)
        .then((found) => told.push({ id: changed, runs: found.length }));
    });

    await engine.runNow(id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(told).toEqual([{ id, runs: 1 }]);
  });

  it("keeps no trigger payload in the run or the action's record when the routine says so", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const calls: { args: Record<string, unknown>; context: Record<string, unknown> }[] = [];
    const actionEngine = {
      run: async (
        _name: string,
        args: Record<string, unknown>,
        context: Record<string, unknown>,
      ) => {
        calls.push({ args, context });
        return { status: "success", result: null };
      },
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 0, systemClock);
    let fire: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
    engine.registerProvider("event-bus", {
      activate: async (_routine: unknown, onFire: typeof fire) => {
        fire = onFire;
      },
      deactivate: () => {},
    } as unknown as TriggerProvider);
    const mail = { subject: "Contract", body: "x".repeat(1000) };
    const trigger: Trigger = { type: "event-bus", eventName: "provider:event:gmail.new" };
    const privateId = await routines.create({
      name: "private",
      trigger,
      actionName: "noop",
      args: {},
      keepTriggerPayload: false,
    });
    await engine.start();
    await fire?.(mail);

    const [run] = await runs.findByRoutineId(privateId);
    expect(run?.payload).toEqual({ omitted: true, bytes: JSON.stringify(mail).length });
    // The action still gets the whole payload; only its record leaves it out.
    expect(calls[0]?.args.__triggerPayload).toEqual(mail);
    expect(calls[0]?.context.omitFromRecord).toEqual(["__triggerPayload"]);
  });

  it("keeps the trigger payload by default, as before", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const contexts: Record<string, unknown>[] = [];
    const actionEngine = {
      run: async (_name: string, _args: unknown, context: Record<string, unknown>) => {
        contexts.push(context);
        return { status: "success", result: null };
      },
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 0, systemClock);
    const id = await routines.create({
      name: "plain",
      trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00" },
      actionName: "noop",
      args: {},
    });
    await engine.runNow(id, { repo: "acme/widgets" });
    const [run] = await runs.findByRoutineId(id);
    expect(run?.payload).toEqual({ repo: "acme/widgets" });
    expect(contexts[0]).not.toHaveProperty("omitFromRecord");
    expect((await routines.findById(id))?.keepTriggerPayload).toBe(true);
  });
});

describe("RoutineEngine worker admission", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it("queues its action for a worker instead of failing on a busy pool", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const run = rs.fn(async () => ({ status: "success", result: null }));
    const engine = new RoutineEngine(
      routines,
      runs,
      { run } as unknown as ActionEngine,
      0,
      systemClock,
    );
    const id = await routines.create({
      name: "digest",
      trigger: { type: "manual" },
      actionName: "noop",
      args: {},
    });

    await engine.runNow(id);

    expect(run).toHaveBeenCalledWith(
      "noop",
      expect.anything(),
      expect.objectContaining({ whenWorkersBusy: "queue" }),
    );
  });
});

describe("RoutineEngine fire audience", () => {
  let testDb: TestDb;
  beforeEach(() => {
    testDb = createTestDb();
  });
  afterEach(() => testDb.close());

  it("fires with the audience of the routine's chat, and shared for a routine of no chat", async () => {
    const routines = new RoutinesRepository(testDb.db, async (chatId) =>
      chatId === "guardian-chat" ? "private" : "shared",
    );
    const run = rs.fn(async () => ({ status: "ok", data: null }));
    const engine = new RoutineEngine(
      routines,
      new RoutineRunsRepository(testDb.db),
      { run } as unknown as ActionEngine,
      0,
      systemClock,
    );
    const inChat = await routines.create({
      name: "steps",
      trigger: { type: "manual" },
      actionName: "core:personal_data_query",
      args: { source: "apple_health", type: "stepCount" },
      madeIn: "guardian-chat",
    });
    const nowhere = await routines.create({
      name: "noop",
      trigger: { type: "manual" },
      actionName: "noop",
      args: {},
    });

    await engine.runNow(inChat);
    await engine.runNow(nowhere);

    expect(run).toHaveBeenNthCalledWith(
      1,
      "core:personal_data_query",
      expect.anything(),
      expect.objectContaining({ audience: "private" }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "noop",
      expect.anything(),
      expect.objectContaining({ audience: "shared" }),
    );
  });
});

describe("RoutineEngine fire context", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => testDb.close());

  it("runs as a root, not nested under the action whose event fired it, retries included", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const seen: Array<{ execution: unknown; replay: unknown; session: unknown }> = [];
    const actionEngine = {
      run: async () => {
        seen.push({
          execution: actionExecutionContext.getStore(),
          replay: replayContext.getStore(),
          session: currentSessionId(),
        });
        // Fail the first attempt so the engine schedules a retry.
        if (seen.length === 1) throw new Error("worker crashed");
        return { status: "success", result: null };
      },
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 1, systemClock);
    let fire: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
    const provider: Pick<TriggerProvider, "activate" | "deactivate"> = {
      activate: async (_routine, onFire) => {
        fire = onFire;
      },
      deactivate: () => {},
    };
    engine.registerProvider("event-bus", provider as TriggerProvider);
    await routines.create({
      name: "stage-2",
      trigger: { type: "event-bus", eventName: "x.y" },
      actionName: "noop",
      args: {},
    });
    await engine.start();

    // Event-bus subscribers fire synchronously inside the publishing action,
    // which itself runs inside the agent turn's session.
    await runWithSession("chat-1", () =>
      replayContext.run({} as ReplayStore, () =>
        actionExecutionContext.run({ agentName: "main" } as ActionExecutionStore, () => fire?.({})),
      ),
    );
    for (let i = 0; i < 100 && seen.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const clean = { execution: undefined, replay: undefined, session: undefined };
    expect(seen).toEqual([clean, clean]);
  });

  it("keeps the payload out of a retry's record too, when the routine keeps none", async () => {
    const routines = new RoutinesRepository(testDb.db);
    const runs = new RoutineRunsRepository(testDb.db);
    const contexts: Record<string, unknown>[] = [];
    const actionEngine = {
      run: async (_name: string, _args: unknown, context: Record<string, unknown>) => {
        contexts.push(context);
        if (contexts.length === 1) throw new Error("worker crashed");
        return { status: "success", result: null };
      },
    } as unknown as ActionEngine;
    const engine = new RoutineEngine(routines, runs, actionEngine, 1, systemClock);
    let fire: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
    engine.registerProvider("event-bus", {
      activate: async (_routine: unknown, onFire: typeof fire) => {
        fire = onFire;
      },
      deactivate: () => {},
    } as unknown as TriggerProvider);
    await routines.create({
      name: "follow",
      trigger: { type: "event-bus", eventName: "x.y" },
      actionName: "noop",
      args: {},
      keepTriggerPayload: false,
    });
    await engine.start();
    await fire?.({ body: "a whole mail" });
    for (let i = 0; i < 100 && contexts.length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => context.omitFromRecord)).toEqual([
      ["__triggerPayload"],
      ["__triggerPayload"],
    ]);
  });
});
