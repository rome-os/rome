import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import type { ActionConfig } from "@rome-os/app-runtime";
import { createTestDb, type TestDb } from "../../../../../packages/core/src/test/helpers.js";
import { RoutinesRepository } from "../../../../../packages/core/src/db/repositories/routines.js";
// Importing the store also registers the current-action-context resolver
// (module side effect), so `getCurrentActionContext()` inside create_routine
// reads whatever store we wrap the call in.
import { actionExecutionContext } from "../../../../../packages/core/src/actions/context.js";
import type { RoutineEngine } from "../../../../../packages/core/src/routines/engine.js";
import type { Routine } from "../../../../../packages/core/src/routines/types.js";
import { createAction, createRoutine } from "./index.js";

/** Run `fn` as if invoked by app `callerAppId` via its app-context runAction —
 * the runtime signal create_routine reads to attribute a routine's `managedBy`. */
function asApp<T>(callerAppId: string, fn: () => Promise<T>): Promise<T> {
  return actionExecutionContext.run(
    { executionId: "exec", rootExecutionId: "root", initiator: `app:${callerAppId}`, callerAppId },
    fn,
  );
}

/** Captures what the engine was asked to activate without a live scheduler. */
function makeFakeEngine(): RoutineEngine & { activated: Routine[] } {
  const activated: Routine[] = [];
  return {
    activated,
    async activate(routine: Routine) {
      activated.push(routine);
    },
  } as unknown as RoutineEngine & { activated: Routine[] };
}

/** An engine whose activate() always fails, to exercise best-effort activation. */
function makeThrowingEngine(): RoutineEngine {
  return {
    async activate() {
      throw new Error("scheduler rejected the cron");
    },
  } as unknown as RoutineEngine;
}

/** Registry stub that recognizes every action — the default for tests whose
 * subject isn't action-existence validation. */
const allActions = { has: () => true };

let testDb: TestDb;
let repo: RoutinesRepository;

beforeEach(() => {
  testDb = createTestDb();
  repo = new RoutinesRepository(testDb.db);
});

afterEach(() => {
  testDb.close();
});

describe("create_routine — engine activation", () => {
  it("persists an enabled recurring routine and activates it", async () => {
    const engine = makeFakeEngine();

    const result = await createRoutine(
      {
        name: "daily-dream",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "03:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const routineId = (result.data as { routineId: string }).routineId;

    const row = await repo.findById(routineId);
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(true);
    expect(row!.actionName).toBe("dream");
    expect(row!.trigger).toMatchObject({ type: "schedule", rrule: "FREQ=DAILY" });

    expect(engine.activated).toHaveLength(1);
    expect(engine.activated[0]).toMatchObject({ id: routineId, name: "daily-dream" });
  });

  it("auto-attributes managedBy to the app that invoked the action", async () => {
    const engine = makeFakeEngine();

    const result = await asApp("briefing", () =>
      createRoutine(
        {
          name: "briefing morning",
          trigger: {
            type: "schedule",
            tzid: "UTC",
            tzMode: "floating",
            localTime: "08:00",
            rrule: "FREQ=DAILY",
          },
          actionName: "send_message",
          args: {},
        },
        { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
      ),
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    // Attribution comes from the calling app, not from any input field.
    expect(row!.managedBy).toBe("briefing");
  });

  it("leaves managedBy unset when no app is the caller (agent/user)", async () => {
    const engine = makeFakeEngine();

    // No app context wrapping → no callerAppId → unmanaged.
    const result = await createRoutine(
      {
        name: "user routine",
        trigger: { type: "manual" },
        actionName: "summon",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    expect(row!.managedBy).toBeNull();
  });

  it("persists an explicit floating tzMode", async () => {
    const engine = makeFakeEngine();
    const result = await createRoutine(
      {
        name: "follow-me",
        trigger: {
          type: "schedule",
          tzid: "Asia/Tokyo",
          tzMode: "floating",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    expect(row!.trigger).toMatchObject({ type: "schedule", tzMode: "floating" });
  });

  it("pins a dated one-off to fixed even when floating is requested", async () => {
    const engine = makeFakeEngine();
    const result = await createRoutine(
      {
        name: "new-years-call",
        trigger: {
          type: "schedule",
          tzid: "Asia/Tokyo",
          tzMode: "floating",
          localTime: "09:00",
          date: "2099-01-01",
        },
        actionName: "summon",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    // The one-off is an absolute instant — its zone is pinned at creation.
    expect(row!.trigger).toMatchObject({ type: "schedule", tzMode: "fixed", date: "2099-01-01" });
  });

  it("preserves an explicit fixed tzMode", async () => {
    const engine = makeFakeEngine();
    const result = await createRoutine(
      {
        name: "pinned",
        trigger: {
          type: "schedule",
          tzid: "Asia/Tokyo",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    expect(row!.trigger).toMatchObject({ type: "schedule", tzMode: "fixed" });
  });

  it("creates an event-bus routine", async () => {
    const engine = makeFakeEngine();

    const result = await createRoutine(
      {
        name: "landlord-emails",
        trigger: {
          type: "event-bus",
          eventName: "provider:event:gmail.gmail_new_gmail_message",
          filter: [{ field: "from.email", equals: "dana@example.com" }],
        },
        actionName: "summon",
        args: { agentName: "main", prompt: "summarize it" },
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    expect(result.status).toBe("ok");
    expect(engine.activated[0]).toMatchObject({
      trigger: { type: "event-bus", eventName: "provider:event:gmail.gmail_new_gmail_message" },
    });
  });

  it("creates a disabled routine without activating it", async () => {
    const engine = makeFakeEngine();

    const result = await createRoutine(
      {
        name: "paused",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
        enabled: false,
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: engine },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    expect(row!.enabled).toBe(false);
    expect(engine.activated).toHaveLength(0);
  });

  it("persists best-effort when engine activation throws", async () => {
    // A scheduler failure after the row is committed must not surface as a hard
    // error (which would make callers retry and duplicate); the boot sweep
    // re-activates it later.
    const result = await createRoutine(
      {
        name: "daily-dream",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "03:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeThrowingEngine() },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    expect(await repo.findById((result.data as { routineId: string }).routineId)).not.toBeNull();
  });
});

describe("create_routine — action factory", () => {
  const actionConfig: ActionConfig = {
    name: "create_routine",
    type: "system",
    description: "Create a routine",
    complexity: "simple",
    speed: "fast",
    reliability: "high",
    sideEffects: "write",
  };

  // The deps bag is untyped at the wiring seam — a missing dep must fail
  // the action load at boot, not degrade to zombie routines at runtime.
  it("createAction refuses to load without a routineEngine dep", () => {
    expect(() =>
      createAction(actionConfig, {
        routinesRepo: repo,
        actionRegistry: allActions,
      } as unknown as Parameters<typeof createAction>[1]),
    ).toThrow(/routineEngine/);
  });

  it("createAction refuses to load without a routinesRepo dep", () => {
    expect(() =>
      createAction(actionConfig, {
        routineEngine: makeFakeEngine(),
        actionRegistry: allActions,
      } as unknown as Parameters<typeof createAction>[1]),
    ).toThrow(/routinesRepo/);
  });

  it("createAction refuses to load without an actionRegistry exposing has()", () => {
    expect(() =>
      createAction(actionConfig, {
        routinesRepo: repo,
        routineEngine: makeFakeEngine(),
        actionRegistry: {},
      } as unknown as Parameters<typeof createAction>[1]),
    ).toThrow(/actionRegistry/);
  });
});

describe("create_routine — validation and fail-closed", () => {
  it("rejects a routine bound to an unregistered action, persisting nothing", async () => {
    const engine = makeFakeEngine();
    // Registry knows the built-ins but not a workflow action that hasn't been built.
    const registry = { has: (n: string) => n === "summon" || n === "send_message" };

    const result = await createRoutine(
      {
        name: "morning-brief",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "07:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "morning_brief_run",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: registry, routineEngine: engine },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    // The error names the remedy so the agent builds a workflow rather than reguessing.
    expect(result.error).toMatch(/not a registered action/);
    expect(result.error).toMatch(/workflow_creation/);
    expect(await repo.findAll()).toHaveLength(0);
    expect(engine.activated).toHaveLength(0);
  });

  it("accepts a routine bound to a built-in action the registry knows", async () => {
    const engine = makeFakeEngine();
    const registry = { has: (n: string) => n === "summon" };

    const result = await createRoutine(
      {
        name: "morning-summon",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "07:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "summon",
        args: { agentName: "assistant", prompt: "review emails" },
      },
      { routinesRepo: repo, actionRegistry: registry, routineEngine: engine },
    );

    expect(result.status).toBe("ok");
    expect(await repo.findAll()).toHaveLength(1);
  });

  it("awaits an async action existence checker", async () => {
    const engine = makeFakeEngine();
    const registry = {
      async has(name: string) {
        return name === "summon";
      },
    };

    const result = await createRoutine(
      {
        name: "async-check",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "07:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "summon",
        args: { agentName: "assistant", prompt: "review emails" },
      },
      { routinesRepo: repo, actionRegistry: registry, routineEngine: engine },
    );

    expect(result.status).toBe("ok");
    expect(await repo.findAll()).toHaveLength(1);
  });

  it("rejects a malformed localTime without persisting a dead schedule", async () => {
    const result = await createRoutine(
      {
        name: "bad",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "9am",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/localTime/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects FREQ=MONTHLY without BYMONTHDAY", async () => {
    const result = await createRoutine(
      {
        name: "monthly",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=MONTHLY",
        },
        actionName: "report",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYMONTHDAY/);
  });

  it("rejects an impossible calendar date", async () => {
    const result = await createRoutine(
      {
        name: "leap",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          date: "2026-02-30",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/not a real calendar date/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects a past-dated one-off so it can't persist as a never-firing routine", async () => {
    const result = await createRoutine(
      {
        name: "expired",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          date: "2020-01-01",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/in the past/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("accepts a clearly-future one-off date", async () => {
    const result = await createRoutine(
      {
        name: "future",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          date: "2099-12-31",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    expect(result.status).toBe("ok");
    expect(await repo.findAll()).toHaveLength(1);
  });

  it("trims whitespace from event-bus trigger strings before persisting", async () => {
    const result = await createRoutine(
      {
        name: "padded",
        trigger: {
          type: "event-bus",
          eventName: "  provider:event:gmail.new  ",
          filter: [{ field: "  from.email  ", equals: " dana@example.com " }],
        },
        actionName: "summon",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    const trigger = row!.trigger as {
      eventName: string;
      filter: Array<{ field: string; equals: string }>;
    };
    expect(trigger.eventName).toBe("provider:event:gmail.new");
    expect(trigger.filter[0].field).toBe("from.email");
    // `equals` is a payload value to match — left exactly as given.
    expect(trigger.filter[0].equals).toBe(" dana@example.com ");
  });

  it("rejects an rrule with a typo'd FREQ instead of firing on the wrong cadence", async () => {
    const result = await createRoutine(
      {
        name: "typo-freq",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=WEKLY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/FREQ/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects an rrule with an unknown BYDAY token", async () => {
    const result = await createRoutine(
      {
        name: "typo-byday",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=WEEKLY;BYDAY=MO,XX",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYDAY/);
  });

  it("rejects INTERVAL=0", async () => {
    const result = await createRoutine(
      {
        name: "zero-interval",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=HOURLY;INTERVAL=0",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/INTERVAL/);
  });

  it("rejects an out-of-range BYMONTHDAY", async () => {
    const result = await createRoutine(
      {
        name: "bad-monthday",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=MONTHLY;BYMONTHDAY=99",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYMONTHDAY/);
  });

  it("rejects an ordinal BYDAY token (1MO)", async () => {
    const result = await createRoutine(
      {
        name: "ordinal-byday",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=WEEKLY;BYDAY=1MO",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYDAY/);
  });

  it("rejects a blank rrule instead of silently degrading to a one-off", async () => {
    const result = await createRoutine(
      {
        name: "blank-rrule",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "fixed", localTime: "09:00", rrule: "" },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/rrule/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects a non-numeric INTERVAL", async () => {
    const result = await createRoutine(
      {
        name: "interval-foo",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=HOURLY;INTERVAL=foo",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/INTERVAL/);
  });

  it("rejects a multi-value BYMONTHDAY instead of silently dropping all but the first", async () => {
    const result = await createRoutine(
      {
        name: "multi-monthday",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=MONTHLY;BYMONTHDAY=1,15",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYMONTHDAY/);
  });

  it("rejects a multi-value BYMONTH", async () => {
    const result = await createRoutine(
      {
        name: "multi-month",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=YEARLY;BYMONTH=1,6;BYMONTHDAY=15",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYMONTH/);
  });

  it("rejects FREQ=WEEKLY without BYDAY (firing day would be nondeterministic)", async () => {
    const result = await createRoutine(
      {
        name: "weekly-no-byday",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=WEEKLY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/BYDAY/);
  });

  it("rejects FREQ=YEARLY missing BYMONTH/BYMONTHDAY", async () => {
    const result = await createRoutine(
      {
        name: "yearly-partial",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=YEARLY;BYMONTH=1",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/YEARLY|BYMONTHDAY/);
  });

  it("accepts a fully-specified YEARLY rrule", async () => {
    const result = await createRoutine(
      {
        name: "new-year",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "00:00",
          rrule: "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=1",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    expect(result.status).toBe("ok");
  });

  it("rejects a repeated rrule clause instead of silently using the first value", async () => {
    const result = await createRoutine(
      {
        name: "dup-interval",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY;INTERVAL=1;INTERVAL=2",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/repeat/i);
  });

  it("rejects an event filter field with an empty path segment", async () => {
    const result = await createRoutine(
      {
        name: "bad-filter-path",
        trigger: {
          type: "event-bus",
          eventName: "provider:event:gmail.gmail_new_gmail_message",
          filter: [{ field: "from..email", equals: "dana@example.com" }],
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/empty path segment/);
  });

  it("rejects a blank name and trims a padded one", async () => {
    const blank = await createRoutine(
      {
        name: "   ",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (blank.status !== "error") throw new Error(`expected error, got ${blank.status}`);
    expect(blank.error).toMatch(/name/);

    const padded = await createRoutine(
      {
        name: "  daily-dream  ",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (padded.status !== "ok") throw new Error(`expected ok, got ${padded.status}`);
    const row = await repo.findById((padded.data as { routineId: string }).routineId);
    expect(row!.name).toBe("daily-dream");
  });

  it("rejects a blank actionName", async () => {
    const result = await createRoutine(
      {
        name: "no-action",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "   ",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/actionName/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("trims actionName before persisting", async () => {
    const result = await createRoutine(
      {
        name: "padded-action",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "  dream  ",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    expect(row!.actionName).toBe("dream");
  });

  it("accepts FREQ=HOURLY;INTERVAL=2 (the sentinel cadence shape)", async () => {
    const result = await createRoutine(
      {
        name: "every-2h",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "00:00",
          rrule: "FREQ=HOURLY;INTERVAL=2",
        },
        actionName: "sentinel_review",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    expect(result.status).toBe("ok");
  });

  it("rejects BYDAY under FREQ=DAILY (the scheduler ignores it)", async () => {
    const result = await createRoutine(
      {
        name: "daily-byday",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY;BYDAY=MO",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/does not support/);
  });

  it("rejects INTERVAL under FREQ=WEEKLY", async () => {
    const result = await createRoutine(
      {
        name: "weekly-interval",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/INTERVAL/);
  });

  it("rejects an unsupported clause like COUNT", async () => {
    const result = await createRoutine(
      {
        name: "counted",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY;COUNT=5",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/COUNT|does not support/);
  });

  it("accepts FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15", async () => {
    const result = await createRoutine(
      {
        name: "every-other-month",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=15",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    expect(result.status).toBe("ok");
  });

  it("accepts a well-formed weekly BYDAY rrule", async () => {
    const result = await createRoutine(
      {
        name: "weekdays",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "08:00",
          rrule: "FREQ=WEEKLY;BYDAY=MO,WE,FR",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    expect(result.status).toBe("ok");
  });

  it("rejects a whitespace-only sourcePattern so it can't widen to all sources", async () => {
    const result = await createRoutine(
      {
        name: "blank-source",
        trigger: {
          type: "event-bus",
          eventName: "provider:event:gmail.new",
          sourcePattern: "   ",
        },
        actionName: "summon",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/sourcePattern/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects a date+rrule conflict", async () => {
    const result = await createRoutine(
      {
        name: "conflict",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          date: "2026-07-01",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/mutually exclusive/);
  });

  it("rejects an event-bus routine with a blank eventName", async () => {
    const result = await createRoutine(
      {
        name: "blank-event",
        trigger: { type: "event-bus", eventName: "   " },
        actionName: "summon",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/eventName/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects an event-bus filter with an empty field", async () => {
    const result = await createRoutine(
      {
        name: "bad-filter",
        trigger: {
          type: "event-bus",
          eventName: "provider:event:gmail.gmail_new_gmail_message",
          filter: [{ field: "", equals: "x" }],
        },
        actionName: "summon",
        args: {},
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/filter condition/);
    expect(await repo.findAll()).toHaveLength(0);
  });

  it("rejects array args (no fan-out)", async () => {
    const result = await createRoutine(
      {
        name: "fanout",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "fixed",
          localTime: "09:00",
          rrule: "FREQ=DAILY",
        },
        actionName: "dream",
        // Force the unsupported array shape past the typed boundary.
        args: [{}] as unknown as Record<string, unknown>,
      },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
    expect(result.error).toMatch(/single object/);
    expect(await repo.findAll()).toHaveLength(0);
  });
});

describe("create_routine — key dedup", () => {
  const scheduleArgs = {
    trigger: {
      type: "schedule" as const,
      tzid: "UTC",
      tzMode: "fixed" as const,
      localTime: "08:00",
      rrule: "FREQ=DAILY",
    },
    actionName: "dream",
    args: {},
  };

  it("persists the key and exposes it on the routine", async () => {
    const result = await createRoutine(
      { name: "Morning brief", key: "briefing-morning", ...scheduleArgs },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    const row = await repo.findById((result.data as { routineId: string }).routineId);
    expect(row!.key).toBe("briefing-morning");
    expect(await repo.findByKey("briefing-morning")).not.toBeNull();
  });

  it("rejects a second routine with an already-used key and does not insert it", async () => {
    const first = await createRoutine(
      { name: "Morning brief", key: "briefing-morning", ...scheduleArgs },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );
    if (first.status !== "ok") throw new Error(`expected ok, got ${first.status}`);

    const second = await createRoutine(
      { name: "Another brief", key: "briefing-morning", ...scheduleArgs },
      { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
    );

    if (second.status !== "error") throw new Error(`expected error, got ${second.status}`);
    expect(second.error).toMatch(/key "briefing-morning" already exists/);
    // The duplicate must not have been inserted — only the first routine remains.
    expect(await repo.findAll()).toHaveLength(1);
  });

  it("allows multiple keyless routines (a blank key is treated as unset)", async () => {
    for (const name of ["one", "two"]) {
      const result = await createRoutine(
        { name, key: "   ", ...scheduleArgs },
        { routinesRepo: repo, actionRegistry: allActions, routineEngine: makeFakeEngine() },
      );
      if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
    }
    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    expect(all.every((r) => r.key === null)).toBe(true);
  });
});
