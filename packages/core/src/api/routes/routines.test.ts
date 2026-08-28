import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { routinesRoutes } from "./routines.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import { RoutineRunsRepository } from "../../db/repositories/routine-runs.js";
import { actionExecutions, routineRuns, routines } from "../../db/schema.js";
import { ActionEngine } from "../../actions/engine.js";
import { ActionRegistryImpl } from "../../actions/registry.js";
import { RoutineEngine } from "../../routines/engine.js";
import { EventBusTriggerProvider } from "../../routines/event-bus-trigger-provider.js";
// The real `manual` trigger provider (distinct from the local schedule double
// confusingly also named ManualTriggerProvider). Registered so a `manual`
// routine passes the create route's hasProvider check.
import { ManualTriggerProvider as RealManualTriggerProvider } from "../../routines/manual-trigger-provider.js";
import { EventBus } from "../../events/event-bus.js";
import type { TriggerProvider } from "../../routines/trigger-provider.js";
import type { Action } from "../../actions/types.js";
import type { ApiDeps } from "../deps.js";
import type { Routine, Trigger } from "../../routines/types.js";
import { FakeClock } from "../../test/kit/index.js";

// Manual trigger provider shared by the CRUD describe (for validateTrigger
// to find a "schedule" provider) and the fire-path describe (to deterministically
// trigger fires). Defined up-front so both describes can register it.
//
// Note: this double does NOT reproduce ScheduleTriggerProvider's post-fire
// side effects (one-off consumption, recurring nextRunAt update). Those are
// pinned by schedule-trigger-provider.test.ts directly.
class ManualTriggerProvider implements TriggerProvider {
  readonly type = "schedule";
  private entries = new Map<
    string,
    { routine: Routine; fire: (payload: Record<string, unknown>) => Promise<void> }
  >();
  /** How many times activate has been called per routine id — lets tests
   * assert that the engine's PATCH/start/etc. paths deactivate before
   * re-activating instead of stacking. */
  private activateCounts = new Map<string, number>();

  async activate(
    routine: Routine,
    fire: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    this.entries.set(routine.id, { routine, fire });
    this.activateCounts.set(routine.id, (this.activateCounts.get(routine.id) ?? 0) + 1);
  }

  async deactivate(routineId: string): Promise<void> {
    this.entries.delete(routineId);
  }

  stop(): void {
    this.entries.clear();
    this.activateCounts.clear();
  }

  isActive(routineId: string): boolean {
    return this.entries.has(routineId);
  }

  activeIds(): string[] {
    return [...this.entries.keys()];
  }

  activateCount(routineId: string): number {
    return this.activateCounts.get(routineId) ?? 0;
  }

  /** Snapshot of the routine the engine handed us at activate-time. */
  routineSnapshot(routineId: string): Routine | undefined {
    return this.entries.get(routineId)?.routine;
  }

  async triggerNow(routineId: string, payload: Record<string, unknown> = {}): Promise<void> {
    const entry = this.entries.get(routineId);
    if (!entry) throw new Error(`no active routine: ${routineId}`);
    await entry.fire(payload);
  }
}

describe("Routines API", () => {
  let testDb: TestDb;
  let app: Hono;
  let routineEngine: RoutineEngine;

  beforeEach(async () => {
    testDb = createTestDb();
    const baseDeps = await buildTestDeps(testDb.db);
    // Wire a minimal RoutineEngine so route-level trigger validation
    // (hasProvider) succeeds for "schedule". CRUD tests don't fire routines.
    routineEngine = new RoutineEngine(
      baseDeps.routinesRepo,
      baseDeps.routineRunsRepo,
      baseDeps.actionEngine,
      0,
      new FakeClock(),
    );
    routineEngine.registerProvider("schedule", new ManualTriggerProvider());
    // CRUD tests bind routines to these stub actions; creation validates
    // actionName against the registry.
    for (const name of [
      "anything",
      "action_a",
      "action_b",
      "send_message",
      "some_action",
      "test_action",
    ]) {
      registerStubAction(baseDeps.actionRegistry, name);
    }
    app = new Hono().route("/", routinesRoutes({ ...baseDeps, routineEngine }));
  });

  afterEach(() => {
    routineEngine.stop();
    testDb.close();
  });

  it("creates a routine with a schedule trigger", async () => {
    const trigger: Trigger = {
      type: "schedule",
      tzid: "America/Los_Angeles",
      tzMode: "fixed",
      localTime: "09:00",
      rrule: "FREQ=DAILY",
    };

    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "daily-standup",
        trigger,
        actionName: "send_message",
        args: { channel: "webchat", text: "standup time!" },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; trigger: Trigger };
    expect(body.name).toBe("daily-standup");
    expect(body.trigger).toEqual(trigger);
  });

  it("rejects creation without trigger", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-trigger",
        actionName: "send_message",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects creation without actionName", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-action",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "12:00" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects args that violate the registered action's full JSON Schema", async () => {
    const baseDeps = await buildTestDeps(testDb.db);
    registerStubAction(baseDeps.actionRegistry, "validated_action", {
      inputSchema: {
        type: "object",
        properties: {
          channel: { type: "string", enum: ["webchat"] },
          op: { type: "string", enum: ["install", "uninstall"] },
          source: { type: "object" },
        },
        required: ["channel", "op"],
        allOf: [
          {
            if: { properties: { op: { const: "install" } }, required: ["op"] },
            then: { required: ["source"] },
          },
        ],
        additionalProperties: false,
      },
    });
    const guardedApp = new Hono().route("/", routinesRoutes({ ...baseDeps, routineEngine }));
    const trigger = {
      type: "schedule" as const,
      tzid: "UTC",
      tzMode: "floating" as const,
      localTime: "12:00",
    };

    for (const args of [
      { channel: "bogus", op: "uninstall" },
      { channel: "webchat", op: "install" },
    ]) {
      const res = await guardedApp.request("/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "invalid", trigger, actionName: "validated_action", args }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(
        "do not satisfy the input schema",
      );
    }

    const accepted = await guardedApp.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "valid",
        trigger,
        actionName: "validated_action",
        args: { channel: "webchat", op: "install", source: {} },
      }),
    });
    expect(accepted.status).toBe(201);
    const { id } = (await accepted.json()) as { id: string };

    const invalidPatch = await guardedApp.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { channel: "bogus", op: "uninstall" } }),
    });
    expect(invalidPatch.status).toBe(400);
  });

  it("rejects an actionName that is not a registered action and names the remedy", async () => {
    // The propose_routine card POSTs here; when actionRegistry is wired (as in
    // production) a routine bound to an unbuilt action is rejected with the
    // remedy, instead of persisting and failing on every fire.
    const registry = new ActionRegistryImpl([]);
    registry.register({
      config: {
        name: "summon",
        type: "system",
        description: "stub",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "read-only",
      },
      async execute() {
        return { status: "ok" };
      },
    });
    const baseDeps = await buildTestDeps(testDb.db);
    const guardedApp = new Hono().route(
      "/",
      routinesRoutes({ ...baseDeps, routineEngine, actionRegistry: registry }),
    );

    const trigger: Trigger = {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "07:00",
      rrule: "FREQ=DAILY",
    };

    const rejected = await guardedApp.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "morning-brief", trigger, actionName: "morning_brief_run" }),
    });
    expect(rejected.status).toBe(400);
    const body = (await rejected.json()) as { error: string };
    expect(body.error).toContain("not a registered action");
    expect(body.error).toContain("workflow_creation");

    // A registered action (e.g. the built-in summon) still creates.
    const accepted = await guardedApp.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "morning-summon", trigger, actionName: "summon" }),
    });
    expect(accepted.status).toBe(201);
  });

  it("rejects re-binding via PATCH to an unregistered action (no guard bypass)", async () => {
    const registry = new ActionRegistryImpl([]);
    registry.register({
      config: {
        name: "summon",
        type: "system",
        description: "stub",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "read-only",
      },
      async execute() {
        return { status: "ok" };
      },
    });
    const baseDeps = await buildTestDeps(testDb.db);
    const guardedApp = new Hono().route(
      "/",
      routinesRoutes({ ...baseDeps, routineEngine, actionRegistry: registry }),
    );
    const trigger: Trigger = {
      type: "schedule",
      tzid: "UTC",
      tzMode: "fixed",
      localTime: "07:00",
      rrule: "FREQ=DAILY",
    };

    // Create bound to a registered action.
    const created = await guardedApp.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "rebind", trigger, actionName: "summon" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    // PATCHing actionName to an unregistered action is rejected, not silently accepted.
    const toGhost = await guardedApp.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionName: "ghost_run" }),
    });
    expect(toGhost.status).toBe(400);
    expect(((await toGhost.json()) as { error: string }).error).toContain(
      "not a registered action",
    );

    // PATCHing other fields (no actionName) still works.
    const renamed = await guardedApp.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "rebind-renamed" }),
    });
    expect(renamed.status).toBe(200);
  });

  it("rejects creation when args contains reserved key __triggerPayload", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "collision",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "12:00" },
        actionName: "anything",
        args: { __triggerPayload: "should be rejected" },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("__triggerPayload");
  });

  it("rejects PATCH when args contains reserved key __triggerPayload", async () => {
    const create = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "patch-collision",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "12:00" },
        actionName: "anything",
      }),
    });
    const { id } = (await create.json()) as { id: string };

    const res = await app.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: { __triggerPayload: "nope" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects args that is not a plain object (fan-out semantics not supported)", async () => {
    // Routine args are a single object. The legacy event system fanned out
    // an array of payloads into multiple invocations; the engine spreads
    // routine.args into one invocation, which would silently turn an
    // array into {0:..., 1:...}. Reject loudly instead.
    for (const badArgs of [[{ a: 1 }, { b: 2 }], "string", 42, null]) {
      const res = await app.request("/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "bad-args",
          trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "12:00" },
          actionName: "anything",
          args: badArgs,
        }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("rejects trigger types with no registered provider", async () => {
    // The engine only has a "schedule" provider in this harness. Webhook /
    // event-bus / poll triggers must be rejected at create time — the
    // alternative was a 201 followed by a routine that silently never fires.
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "wrong-type",
        trigger: { type: "webhook", path: "hook-x" },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("webhook");
  });

  it("rejects schedule trigger with malformed localTime", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-time",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "9am" },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects schedule trigger missing tzid", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-tz",
        trigger: { type: "schedule", localTime: "09:00" },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects schedule trigger with unknown tzid", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "fake-tz",
        trigger: {
          type: "schedule",
          tzid: "Atlantis/Underwater",
          tzMode: "floating",
          localTime: "09:00",
        },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects schedule trigger with both date and rrule (ambiguous)", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "ambiguous",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "floating",
          localTime: "09:00",
          date: "2030-01-01",
          rrule: "FREQ=DAILY",
        },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects schedule trigger with a date in the past", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "past",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "floating",
          localTime: "09:00",
          date: "2020-01-01",
        },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts schedule trigger with a future date (one-off)", async () => {
    const res = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "future-one-off",
        trigger: {
          type: "schedule",
          tzid: "UTC",
          tzMode: "floating",
          localTime: "09:00",
          date: "2099-12-31",
        },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("judges a dated one-off against its tzid, not UTC", async () => {
    // At 16:00Z it is already 2026-06-24 01:00 in Tokyo. A one-off at 00:30
    // Tokyo (= 2026-06-23T15:30Z) is in the past; a UTC-naive check with a 24h
    // grace would have wrongly accepted it.
    rs.useFakeTimers({ shouldAdvanceTime: false });
    try {
      rs.setSystemTime(new Date("2026-06-23T16:00:00Z"));
      const past = await app.request("/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "tokyo-past",
          trigger: {
            type: "schedule",
            tzid: "Asia/Tokyo",
            tzMode: "floating",
            localTime: "00:30",
            date: "2026-06-24",
          },
          actionName: "anything",
        }),
      });
      expect(past.status).toBe(400);

      // 02:00 Tokyo (= 2026-06-23T17:00Z) is still in the future → accepted.
      const future = await app.request("/routines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "tokyo-future",
          trigger: {
            type: "schedule",
            tzid: "Asia/Tokyo",
            tzMode: "floating",
            localTime: "02:00",
            date: "2026-06-24",
          },
          actionName: "anything",
        }),
      });
      expect(future.status).toBe(201);
    } finally {
      rs.useRealTimers();
    }
  });

  it("lists created routines", async () => {
    await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "routine-a",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "08:00" },
        actionName: "action_a",
      }),
    });
    await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "routine-b",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "09:00" },
        actionName: "action_b",
      }),
    });

    const res = await app.request("/routines");
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { name: string }[];
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.name)).toEqual(expect.arrayContaining(["routine-a", "routine-b"]));
  });

  it("patches an existing routine", async () => {
    const create = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "original",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "10:00" },
        actionName: "some_action",
      }),
    });
    const created = (await create.json()) as { id: string };

    const patch = await app.request(`/routines/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "updated-name", enabled: false }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { name: string; enabled: boolean };
    expect(updated.name).toBe("updated-name");
    expect(updated.enabled).toBe(false);
  });

  it("rejects patch with no fields as 400", async () => {
    const create = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "10:00" },
        actionName: "some_action",
      }),
    });
    const created = (await create.json()) as { id: string };

    const res = await app.request(`/routines/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when patching unknown id", async () => {
    const res = await app.request("/routines/nonexistent", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("deletes a routine", async () => {
    const create = await app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "to-delete",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "10:00" },
        actionName: "some_action",
      }),
    });
    const created = (await create.json()) as { id: string };

    const del = await app.request(`/routines/${created.id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // Second delete should 404
    const del2 = await app.request(`/routines/${created.id}`, {
      method: "DELETE",
    });
    expect(del2.status).toBe(404);
  });

  it("refuses (403) to delete an app-managed routine and keeps it", async () => {
    // Seed a routine owned by the "briefing" app directly — the dashboard has no
    // way to create a managed routine, so insert one to exercise the guard.
    const id = "managed-routine-1";
    await testDb.db.insert(routines).values({
      id,
      name: "briefing morning",
      managedBy: "briefing",
      enabled: true,
      trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "08:00" },
      actionName: "some_action",
      args: {},
      createdAt: new Date(),
    });

    const del = await app.request(`/routines/${id}`, { method: "DELETE" });
    expect(del.status).toBe(403);
    expect(((await del.json()) as { error: string }).error).toMatch(
      /managed by the "briefing" app/,
    );

    // The routine must survive the refused delete.
    const [row] = await testDb.db.select().from(routines).where(eq(routines.id, id));
    expect(row).toBeDefined();
  });

  it("returns runs for a routine", async () => {
    const deps = await buildTestDeps(testDb.db);
    registerStubAction(deps.actionRegistry, "test_action");
    const routineRunsRepo = new RoutineRunsRepository(testDb.db);
    const appWithRuns = new Hono().route(
      "/",
      routinesRoutes({ ...deps, routineRunsRepo, routineEngine }),
    );

    const create = await appWithRuns.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "with-runs",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "10:00" },
        actionName: "test_action",
      }),
    });
    const created = (await create.json()) as { id: string };

    await routineRunsRepo.create({
      routineId: created.id,
      executionId: "exec-001",
      status: "success",
      payload: { scheduledTime: "2026-05-25T10:00:00Z" },
    });

    const runsRes = await appWithRuns.request(`/routines/${created.id}/runs?limit=10`);
    expect(runsRes.status).toBe(200);
    const runs = (await runsRes.json()) as { routineId: string; status: string }[];
    expect(runs.length).toBe(1);
    expect(runs[0].status).toBe("success");
  });

  it("returns stats for a routine", async () => {
    const deps = await buildTestDeps(testDb.db);
    registerStubAction(deps.actionRegistry, "test_action");
    const routineRunsRepo = new RoutineRunsRepository(testDb.db);
    const appWithRuns = new Hono().route(
      "/",
      routinesRoutes({ ...deps, routineRunsRepo, routineEngine }),
    );

    const create = await appWithRuns.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "stats-routine",
        trigger: { type: "schedule", tzid: "UTC", tzMode: "floating", localTime: "10:00" },
        actionName: "test_action",
      }),
    });
    const created = (await create.json()) as { id: string };

    const runId1 = await routineRunsRepo.create({
      routineId: created.id,
      executionId: "exec-001",
      status: "success",
    });
    await routineRunsRepo.updateStatus(runId1, {
      status: "success",
      durationMs: 100,
    });

    const runId2 = await routineRunsRepo.create({
      routineId: created.id,
      executionId: "exec-002",
      status: "error",
    });
    await routineRunsRepo.updateStatus(runId2, {
      status: "error",
      durationMs: 200,
      error: "something failed",
    });

    const statsRes = await appWithRuns.request(`/routines/${created.id}/stats`);
    expect(statsRes.status).toBe(200);
    const stats = (await statsRes.json()) as {
      totalRuns: number;
      successCount: number;
      errorCount: number;
    };
    expect(stats.totalRuns).toBe(2);
    expect(stats.successCount).toBe(1);
    expect(stats.errorCount).toBe(1);
  });
});

// Routines fire path — exercises POST /routines → engine.activate → provider
// fires → engine.dispatch → action executes → /runs + /stats reflect outcome.
// Uses the same ManualTriggerProvider declared at the top of the file so
// tests can trigger fires deterministically without waiting on a real
// schedule.

interface StubActionRecord {
  args: Record<string, unknown>;
}

function registerStubAction(
  registry: ActionRegistryImpl,
  name: string,
  opts: {
    fail?: string;
    returnError?: string;
    pendingApproval?: boolean;
    inputSchema?: Record<string, unknown>;
  } = {},
): { calls: StubActionRecord[] } {
  const calls: StubActionRecord[] = [];
  const stub: Action = {
    config: {
      name,
      type: "system",
      description: "test stub",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: opts.inputSchema,
    async execute(args) {
      calls.push({ args });
      if (opts.fail) throw new Error(opts.fail);
      // A structured domain error: the action reports failure by returning,
      // not throwing. The engine must record the run as error, not success.
      if (opts.returnError) return { status: "error", error: opts.returnError };
      if (opts.pendingApproval) {
        return {
          status: "pending_approval",
          approval: {
            approvalId: "approval-test",
            actionName: name,
            description: "stub awaiting approval",
          },
        };
      }
      return { status: "ok" };
    },
  };
  registry.register(stub);
  return { calls };
}

interface FireHarness {
  app: Hono;
  manualProvider: ManualTriggerProvider;
  actionRegistry: ActionRegistryImpl;
  routineEngine: RoutineEngine;
  eventBus: EventBus;
  clock: FakeClock;
  routinesRepo: Awaited<ReturnType<typeof buildTestDeps>>["routinesRepo"];
  routineRunsRepo: RoutineRunsRepository;
  db: TestDb["db"];
}

async function buildFireHarness(testDb: TestDb, retryDelayMs = 0): Promise<FireHarness> {
  const baseDeps = await buildTestDeps(testDb.db);
  // Use processRole "worker" so root actions execute in-process — the default
  // "main" path forks a subprocess which has no test entrypoint and can't be
  // observed via captures.
  const actionRegistry = new ActionRegistryImpl([]);
  // Both engines share one FakeClock, so run durations / lastFiredAt are
  // exact and retry timers fire only when a test advances the clock.
  const clock = new FakeClock();
  const actionEngine = new ActionEngine(
    actionRegistry,
    undefined,
    baseDeps.actionExecutionsRepo,
    baseDeps.approvalsRepo,
    baseDeps.executionJournalRepo,
    { processRole: "worker", clock },
  );
  const manualProvider = new ManualTriggerProvider();
  // retryDelayMs defaults to 0 (retry disabled) — most fire-path tests pin
  // non-retry behavior. Retry tests pass the production 30s delay and drive
  // the FakeClock across it.
  const routineEngine = new RoutineEngine(
    baseDeps.routinesRepo,
    baseDeps.routineRunsRepo,
    actionEngine,
    retryDelayMs,
    clock,
  );
  routineEngine.registerProvider("schedule", manualProvider);
  const eventBus = new EventBus();
  routineEngine.registerProvider("event-bus", new EventBusTriggerProvider(eventBus));
  routineEngine.registerProvider("manual", new RealManualTriggerProvider());

  const deps: ApiDeps = {
    ...baseDeps,
    actionEngine,
    actionRegistry,
    routineEngine,
  };
  const app = new Hono().route("/", routinesRoutes(deps));

  return {
    app,
    manualProvider,
    actionRegistry,
    routineEngine,
    eventBus,
    clock,
    routinesRepo: baseDeps.routinesRepo,
    routineRunsRepo: baseDeps.routineRunsRepo,
    db: testDb.db,
  };
}

/** Poll the runs endpoint until at least `count` runs exist and the most
 * recent has reached a terminal status. Event-bus fires are fire-and-forget,
 * so both the row insert (status "running") and the terminal-status update
 * land on microtasks after `publish()` returns. */
async function waitForRuns(
  app: Hono,
  routineId: string,
  count: number,
): Promise<Array<{ status: string; payload?: Record<string, unknown> }>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const res = await app.request(`/routines/${routineId}/runs`);
    const runs = (await res.json()) as Array<{
      status: string;
      payload?: Record<string, unknown>;
    }>;
    if (runs.length >= count && runs[0].status !== "running") return runs;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${count} settled run(s) of ${routineId}`);
}

async function createRoutineViaApi(
  app: Hono,
  body: {
    name: string;
    trigger: Trigger;
    actionName: string;
    args?: Record<string, unknown>;
    enabled?: boolean;
  },
): Promise<{ id: string }> {
  const res = await app.request("/routines", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    throw new Error(`create failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { id: string };
}

describe("Routines fire path", () => {
  let testDb: TestDb;
  let harness: FireHarness;

  beforeEach(async () => {
    testDb = createTestDb();
    harness = await buildFireHarness(testDb);
  });

  afterEach(() => {
    harness.routineEngine.stop();
    testDb.close();
  });

  const scheduleTrigger: Trigger = {
    type: "schedule",
    tzid: "UTC",
    tzMode: "fixed",
    localTime: "09:00",
    rrule: "FREQ=DAILY",
  };

  it("activates an enabled routine on creation and invokes its action when fired", async () => {
    const stub = registerStubAction(harness.actionRegistry, "send_message");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "morning brief",
      trigger: scheduleTrigger,
      actionName: "send_message",
      args: { channel: "webchat", text: "hi" },
    });

    expect(harness.manualProvider.isActive(id)).toBe(true);

    await harness.manualProvider.triggerNow(id, {
      scheduledTime: "2026-05-25T09:00:00Z",
    });

    // Action was invoked, with routine args merged with the trigger payload
    // under __triggerPayload (the engine's merge contract).
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].args).toEqual({
      channel: "webchat",
      text: "hi",
      __triggerPayload: { scheduledTime: "2026-05-25T09:00:00Z" },
    });

    // A successful run row exists, observable via /runs
    const runsRes = await harness.app.request(`/routines/${id}/runs`);
    const runs = (await runsRes.json()) as {
      status: string;
      executionId: string;
      durationMs?: number;
      payload?: Record<string, unknown>;
    }[];
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].executionId).toBeTruthy();
    expect(typeof runs[0].durationMs).toBe("number");
    expect(runs[0].durationMs!).toBeGreaterThanOrEqual(0);
    expect(runs[0].durationMs!).toBeLessThan(5_000);
    expect(runs[0].payload).toEqual({ scheduledTime: "2026-05-25T09:00:00Z" });

    // The same executionId links to the action_executions tree the engine wrote
    const execRows = await harness.db
      .select()
      .from(actionExecutions)
      .where(eq(actionExecutions.rootExecutionId, runs[0].executionId));
    expect(execRows.length).toBeGreaterThan(0);
    expect(execRows[0].actionName).toBe("send_message");
    expect(execRows[0].initiator).toBe("routine:morning brief");
    expect(execRows[0].status).toBe("success");

    // Routine.lastFiredAt was updated
    const stored = await harness.routinesRepo.findById(id);
    expect(stored).not.toBeNull();
    expect(stored!.lastFiredAt).toBeInstanceOf(Date);
  });

  it("does not activate a routine created with enabled=false", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "disabled-from-birth",
      trigger: scheduleTrigger,
      actionName: "noop_action",
      enabled: false,
    });
    expect(harness.manualProvider.isActive(id)).toBe(false);
    expect(harness.manualProvider.activeIds()).not.toContain(id);
  });

  it("PATCH enabled=false deactivates a live routine", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "toggle-off",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    expect(harness.manualProvider.isActive(id)).toBe(true);

    const patch = await harness.app.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(harness.manualProvider.isActive(id)).toBe(false);
  });

  it("PATCH enabled=true re-activates a previously disabled routine", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "toggle-on",
      trigger: scheduleTrigger,
      actionName: "noop_action",
      enabled: false,
    });
    expect(harness.manualProvider.isActive(id)).toBe(false);

    await harness.app.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(harness.manualProvider.isActive(id)).toBe(true);
  });

  it("PATCH trigger re-activates the routine with the new trigger spec", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "reschedule",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    expect(harness.manualProvider.routineSnapshot(id)?.trigger.type).toBe("schedule");
    expect(harness.manualProvider.activateCount(id)).toBe(1);

    const newTrigger: Trigger = {
      type: "schedule",
      tzid: "Asia/Shanghai",
      tzMode: "fixed",
      localTime: "23:00",
    };
    await harness.app.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger: newTrigger }),
    });
    const snapshot = harness.manualProvider.routineSnapshot(id);
    expect(snapshot?.trigger).toEqual(newTrigger);
    // The engine must deactivate-then-reactivate, not stack — entries.size
    // stays 1 even though activate has been called twice.
    expect(harness.manualProvider.activateCount(id)).toBe(2);
    expect(harness.manualProvider.activeIds()).toEqual([id]);
  });

  it("PATCH name-only still re-activates (engine deactivates+reactivates on any PATCH)", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "rename",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    expect(harness.manualProvider.activateCount(id)).toBe(1);

    await harness.app.request(`/routines/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "renamed" }),
    });
    expect(harness.manualProvider.isActive(id)).toBe(true);
    expect(harness.manualProvider.activateCount(id)).toBe(2);
    expect(harness.manualProvider.routineSnapshot(id)?.name).toBe("renamed");
  });

  it("DELETE deactivates the routine and cascades its run rows", async () => {
    const stub = registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "delete-me",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    await harness.manualProvider.triggerNow(id);
    expect(stub.calls).toHaveLength(1);
    let runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs).toHaveLength(1);

    const del = await harness.app.request(`/routines/${id}`, {
      method: "DELETE",
    });
    expect(del.status).toBe(200);

    expect(harness.manualProvider.isActive(id)).toBe(false);
    runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs).toHaveLength(0);
  });

  it("records status=error, bumps lastFiredAt, and skips retry when retryDelayMs=0", async () => {
    registerStubAction(harness.actionRegistry, "failing_action", {
      fail: "kaboom",
    });
    const { id } = await createRoutineViaApi(harness.app, {
      name: "fails",
      trigger: scheduleTrigger,
      actionName: "failing_action",
    });
    await harness.manualProvider.triggerNow(id);

    const runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("kaboom");
    // Duration is measured on the engine clock, which the test never advanced.
    expect(runs[0].durationMs).toBe(0);

    // Failures still bump lastFiredAt — the engine updates it after the
    // try/catch in dispatch().
    const stored = await harness.routinesRepo.findById(id);
    expect(stored).not.toBeNull();
    expect(stored!.lastFiredAt).toEqual(harness.clock.now());
  });

  it("records status=error with the message when the action returns a structured error", async () => {
    // The action returns `{status:"error"}` without throwing. Before the fix the
    // run was recorded "success" (only thrown errors were caught), so the detail
    // view's trace showed a failing leaf under a green run header.
    registerStubAction(harness.actionRegistry, "soft_failing_action", {
      returnError: "model request timed out",
    });
    const { id } = await createRoutineViaApi(harness.app, {
      name: "soft-fails",
      trigger: scheduleTrigger,
      actionName: "soft_failing_action",
    });
    await harness.manualProvider.triggerNow(id);

    const runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("error");
    expect(runs[0].error).toContain("model request timed out");
  });

  it("does not retry an action that returns a structured error (only thrown ones retry)", async () => {
    const localDb = createTestDb();
    const retryHarness = await buildFireHarness(localDb, 30_000);
    try {
      const stub = registerStubAction(retryHarness.actionRegistry, "always_soft_fails", {
        returnError: "permanent config error",
      });
      const { id } = await createRoutineViaApi(retryHarness.app, {
        name: "no-retry-on-return",
        trigger: scheduleTrigger,
        actionName: "always_soft_fails",
      });
      await retryHarness.manualProvider.triggerNow(id);

      expect(stub.calls).toHaveLength(1);
      const runs = await retryHarness.routineRunsRepo.findByRoutineId(id);
      expect(runs[0].status).toBe("error");

      // Past the retry delay the action must not re-run — a returned error is a
      // deliberate failure, so (unlike a thrown one) it does not take the retry path.
      await retryHarness.clock.advance("60s");
      expect(stub.calls).toHaveLength(1);
      expect(await retryHarness.routineRunsRepo.findByRoutineId(id)).toHaveLength(1);
    } finally {
      retryHarness.routineEngine.stop();
      localDb.close();
    }
  });

  /** Harness with the production 30s retry delay plus a registered action
   * that fails its first call and succeeds the retry. */
  async function buildRetryScenario(testDbForRetry: TestDb) {
    const retryHarness = await buildFireHarness(testDbForRetry, 30_000);
    const flaky = { calls: 0 };
    retryHarness.actionRegistry.register({
      config: {
        name: "flaky",
        type: "system",
        description: "fails once",
        complexity: "simple",
        speed: "fast",
        reliability: "high",
        sideEffects: "read-only",
      },
      async execute() {
        flaky.calls++;
        if (flaky.calls === 1) throw new Error("first try fails");
        return { status: "ok" };
      },
    });
    return { retryHarness, flaky };
  }

  it("retries a failed action exactly once the retry delay elapses, not before", async () => {
    const localDb = createTestDb();
    const { retryHarness, flaky } = await buildRetryScenario(localDb);
    try {
      const { id } = await createRoutineViaApi(retryHarness.app, {
        name: "retry-me",
        trigger: scheduleTrigger,
        actionName: "flaky",
      });
      await retryHarness.manualProvider.triggerNow(id);

      // First attempt recorded as error
      const runs = await retryHarness.routineRunsRepo.findByRoutineId(id);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("error");

      await retryHarness.clock.advance("29s");
      expect(flaky.calls).toBe(1);

      await retryHarness.clock.advance("1s");
      expect(flaky.calls).toBe(2);

      // The retry is fire-and-forget: it does not record a second run row.
      expect(await retryHarness.routineRunsRepo.findByRoutineId(id)).toHaveLength(1);
    } finally {
      retryHarness.routineEngine.stop();
      localDb.close();
    }
  });

  it("stop() cancels a scheduled retry", async () => {
    const localDb = createTestDb();
    const { retryHarness, flaky } = await buildRetryScenario(localDb);
    try {
      const { id } = await createRoutineViaApi(retryHarness.app, {
        name: "retry-me",
        trigger: scheduleTrigger,
        actionName: "flaky",
      });
      await retryHarness.manualProvider.triggerNow(id);
      expect(flaky.calls).toBe(1);

      retryHarness.routineEngine.stop();
      await retryHarness.clock.advance("31s");
      expect(flaky.calls).toBe(1);
    } finally {
      localDb.close();
    }
  });

  it("records status=pending_approval, bumps lastFiredAt, and does not schedule a retry", async () => {
    registerStubAction(harness.actionRegistry, "needs_approval", {
      pendingApproval: true,
    });
    const { id } = await createRoutineViaApi(harness.app, {
      name: "approval",
      trigger: scheduleTrigger,
      actionName: "needs_approval",
    });
    await harness.manualProvider.triggerNow(id);

    const runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("pending_approval");
    const stored = await harness.routinesRepo.findById(id);
    expect(stored!.lastFiredAt).toEqual(harness.clock.now());
  });

  it("/runs returns rows in firedAt-desc order and respects limit + offset", async () => {
    registerStubAction(harness.actionRegistry, "anything");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "paginate",
      trigger: scheduleTrigger,
      actionName: "anything",
    });

    // `firedAt` is stored as Unix seconds (Drizzle `mode: "timestamp"`), so
    // rows created within the same second collide and orderBy desc becomes
    // unstable. Insert directly with explicit, spaced firedAt timestamps.
    const base = new Date("2026-05-25T09:00:00Z").getTime();
    for (let i = 0; i < 25; i++) {
      await harness.db.insert(routineRuns).values({
        id: `run-${i.toString().padStart(3, "0")}`,
        routineId: id,
        executionId: `exec-${i.toString().padStart(3, "0")}`,
        status: "success",
        payload: { idx: i } as unknown,
        firedAt: new Date(base + i * 60_000), // 1 minute apart
        durationMs: null,
        error: null,
      });
    }

    const page1 = await harness.app.request(`/routines/${id}/runs?limit=10`);
    const rows1 = (await page1.json()) as { executionId: string }[];
    expect(rows1).toHaveLength(10);
    // Newest first
    expect(rows1[0].executionId).toBe("exec-024");
    expect(rows1[9].executionId).toBe("exec-015");

    const page2 = await harness.app.request(`/routines/${id}/runs?limit=10&offset=10`);
    const rows2 = (await page2.json()) as { executionId: string }[];
    expect(rows2).toHaveLength(10);
    expect(rows2[0].executionId).toBe("exec-014");
    expect(rows2[9].executionId).toBe("exec-005");
  });

  it("/stats reports avgDurationMs, lastStatus, and lastFiredAt", async () => {
    registerStubAction(harness.actionRegistry, "anything");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "stats",
      trigger: scheduleTrigger,
      actionName: "anything",
    });

    // Same firedAt-collision concern as the pagination test — seed directly
    // with explicit, spaced timestamps so "last run" is unambiguous.
    const t1 = new Date("2026-05-25T09:00:00Z");
    const t2 = new Date("2026-05-25T09:01:00Z");
    await harness.db.insert(routineRuns).values({
      id: "run-1",
      routineId: id,
      executionId: "e-1",
      status: "success",
      payload: null as unknown,
      firedAt: t1,
      durationMs: 100,
      error: null,
    });
    await harness.db.insert(routineRuns).values({
      id: "run-2",
      routineId: id,
      executionId: "e-2",
      status: "error",
      payload: null as unknown,
      firedAt: t2,
      durationMs: 300,
      error: "nope",
    });

    const res = await harness.app.request(`/routines/${id}/stats`);
    const stats = (await res.json()) as {
      totalRuns: number;
      successCount: number;
      errorCount: number;
      avgDurationMs: number | null;
      lastStatus: string | null;
      lastFiredAt: string | null;
    };
    expect(stats.totalRuns).toBe(2);
    expect(stats.successCount).toBe(1);
    expect(stats.errorCount).toBe(1);
    // SQLite avg() returns a float — use toBeCloseTo to avoid IEEE-754 jitter
    // if seeded durations ever change.
    expect(stats.avgDurationMs).not.toBeNull();
    expect(stats.avgDurationMs!).toBeCloseTo(200, 5);
    // Last run was r2 (error)
    expect(stats.lastStatus).toBe("error");
    // lastFiredAt round-trips through Hono JSON as a number (Drizzle timestamp
    // mode + JSON.stringify of Date). Either way, assert it matches t2 exactly.
    expect(stats.lastFiredAt).not.toBeNull();
    expect(new Date(stats.lastFiredAt!).toISOString()).toBe(t2.toISOString());
  });

  it("engine.start() hydrates enabled routines persisted in the DB", async () => {
    // Insert a routine directly into the DB, bypassing the API + engine,
    // so we can verify engine.start() picks it up on boot.
    const persistedId = await harness.routinesRepo.create({
      name: "boot-hydration",
      trigger: scheduleTrigger,
      actionName: "anything",
      args: {},
      enabled: true,
    });
    const disabledId = await harness.routinesRepo.create({
      name: "boot-disabled",
      trigger: scheduleTrigger,
      actionName: "anything",
      args: {},
      enabled: false,
    });

    // Nothing active yet — start() was never called on this engine
    expect(harness.manualProvider.isActive(persistedId)).toBe(false);

    await harness.routineEngine.start();

    expect(harness.manualProvider.isActive(persistedId)).toBe(true);
    expect(harness.manualProvider.isActive(disabledId)).toBe(false);
  });

  it("accepts an event-bus routine and fires its action when a matching event is published", async () => {
    const stub = registerStubAction(harness.actionRegistry, "handle_order");
    // createRoutineViaApi throws unless the POST returns 201 — so this also
    // asserts the API now accepts an event-bus trigger (previously rejected).
    const { id } = await createRoutineViaApi(harness.app, {
      name: "on-order",
      trigger: { type: "event-bus", eventName: "order.created" },
      actionName: "handle_order",
      args: { notify: true },
    });

    harness.eventBus.publish({
      name: "order.created",
      source: "connector.shop",
      payload: { orderId: 7 },
      emittedAt: new Date().toISOString(),
    });

    const runs = await waitForRuns(harness.app, id, 1);
    expect(runs[0].status).toBe("success");
    expect(runs[0].payload).toEqual({ orderId: 7 });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].args).toEqual({
      notify: true,
      __triggerPayload: { orderId: 7 },
    });

    const stored = await harness.routinesRepo.findById(id);
    expect(stored!.lastFiredAt).toBeInstanceOf(Date);
  });

  it("does not fire an event-bus routine when the published event name differs", async () => {
    const stub = registerStubAction(harness.actionRegistry, "handle_order2");
    await createRoutineViaApi(harness.app, {
      name: "on-order-2",
      trigger: { type: "event-bus", eventName: "order.created" },
      actionName: "handle_order2",
    });

    harness.eventBus.publish({
      name: "order.shipped",
      source: "connector.shop",
      payload: {},
      emittedAt: new Date().toISOString(),
    });

    // Give any erroneous fire a chance to run before asserting it didn't.
    await new Promise((r) => setTimeout(r, 20));
    expect(stub.calls).toHaveLength(0);
  });

  it("rejects an event-bus routine with no eventName", async () => {
    registerStubAction(harness.actionRegistry, "anything");
    const res = await harness.app.request("/routines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "no-event-name",
        trigger: { type: "event-bus" },
        actionName: "anything",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("eventName");
  });
});

// "Try run now" — POST /routines/:id/run fires the action out of band from its
// trigger. Reuses the fire harness (real action engine + manual provider) so
// the run flows through the same dispatch path as a scheduled fire.

describe("Routines run-now", () => {
  let testDb: TestDb;
  let harness: FireHarness;

  beforeEach(async () => {
    testDb = createTestDb();
    harness = await buildFireHarness(testDb);
  });

  afterEach(() => {
    harness.routineEngine.stop();
    testDb.close();
  });

  const scheduleTrigger: Trigger = {
    type: "schedule",
    tzid: "UTC",
    tzMode: "fixed",
    localTime: "09:00",
    rrule: "FREQ=DAILY",
  };

  it("fires the action immediately, records a success run, and does not bump lastFiredAt", async () => {
    const stub = registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "run-me",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });

    const res = await harness.app.request(`/routines/${id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; status: string };
    expect(body.status).toBe("success");
    expect(body.runId).toBeTruthy();

    expect(stub.calls).toHaveLength(1);
    const runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");

    // A manual run is out of band from the schedule — it must not bump
    // lastFiredAt (that would misreport when the routine last fired on its own).
    const stored = await harness.routinesRepo.findById(id);
    expect(stored!.lastFiredAt).toBeNull();
  });

  it("runs a manual-trigger routine and passes a request payload as __triggerPayload", async () => {
    const stub = registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "manual-me",
      trigger: { type: "manual" },
      actionName: "noop_action",
      args: { base: 1 },
    });

    const res = await harness.app.request(`/routines/${id}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: { orderId: 7 } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("success");

    // The action sees its static args plus the run-supplied payload under the
    // engine's reserved key.
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].args).toMatchObject({
      base: 1,
      __triggerPayload: { orderId: 7 },
    });
  });

  it("runs a disabled routine on demand", async () => {
    const stub = registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "disabled-run",
      trigger: scheduleTrigger,
      actionName: "noop_action",
      enabled: false,
    });

    const res = await harness.app.request(`/routines/${id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("success");
    expect(stub.calls).toHaveLength(1);
  });

  it("reports a run-level failure as status=error over HTTP 200 (no retry)", async () => {
    const localDb = createTestDb();
    // Production retry delay so a queued retry would be observable if one fired.
    const retryHarness = await buildFireHarness(localDb, 30_000);
    try {
      const stub = registerStubAction(retryHarness.actionRegistry, "failing_action", {
        fail: "kaboom",
      });
      const { id } = await createRoutineViaApi(retryHarness.app, {
        name: "fails-now",
        trigger: scheduleTrigger,
        actionName: "failing_action",
      });

      const res = await retryHarness.app.request(`/routines/${id}/run`, { method: "POST" });
      // The HTTP call succeeded; the failure lives in the body.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; error?: string };
      expect(body.status).toBe("error");
      expect(body.error).toContain("kaboom");

      const runs = await retryHarness.routineRunsRepo.findByRoutineId(id);
      expect(runs).toHaveLength(1);
      expect(runs[0].status).toBe("error");

      // A manual run never queues a background retry, even with a retry delay:
      // advancing past the delay triggers no second action call.
      expect(stub.calls).toHaveLength(1);
      await retryHarness.clock.advance("31s");
      expect(stub.calls).toHaveLength(1);
      expect(await retryHarness.routineRunsRepo.findByRoutineId(id)).toHaveLength(1);
    } finally {
      retryHarness.routineEngine.stop();
      localDb.close();
    }
  });

  it("returns 404 for an unknown routine id", async () => {
    const res = await harness.app.request("/routines/does-not-exist/run", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// List enrichment — GET /routines attaches each routine's latest run so the
// dashboard can render the status badge without per-card requests.

describe("Routines list lastRun enrichment", () => {
  let testDb: TestDb;
  let harness: FireHarness;

  beforeEach(async () => {
    testDb = createTestDb();
    harness = await buildFireHarness(testDb);
  });

  afterEach(() => {
    harness.routineEngine.stop();
    testDb.close();
  });

  const scheduleTrigger: Trigger = {
    type: "schedule",
    tzid: "UTC",
    tzMode: "fixed",
    localTime: "09:00",
    rrule: "FREQ=DAILY",
  };

  async function listById(id: string) {
    const res = await harness.app.request("/routines");
    const rows = (await res.json()) as Array<{
      id: string;
      lastRun: { status: string; firedAt: string } | null;
    }>;
    return rows.find((r) => r.id === id);
  }

  it("reports lastRun: null for a routine that has never run", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "fresh",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    expect((await listById(id))?.lastRun).toBeNull();
  });

  it("reports the latest run's status after a successful fire", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "ran-ok",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    await harness.manualProvider.triggerNow(id);

    const row = await listById(id);
    expect(row?.lastRun?.status).toBe("success");
    expect(row?.lastRun?.firedAt).toBeTruthy();
  });

  it("surfaces error as the latest status after a failed fire", async () => {
    registerStubAction(harness.actionRegistry, "failing_action", { fail: "kaboom" });
    const { id } = await createRoutineViaApi(harness.app, {
      name: "ran-bad",
      trigger: scheduleTrigger,
      actionName: "failing_action",
    });
    await harness.manualProvider.triggerNow(id);

    expect((await listById(id))?.lastRun?.status).toBe("error");
  });
});

// Stop / cancel — POST /routines/:id/cancel forces an active run to a terminal
// "cancelled". The priority is repairing a run left stuck "running" by a server
// restart (no live process to kill); killing a genuinely live subprocess is a
// real-process concern the in-process test harness can't exercise.

describe("Routines cancel (stop)", () => {
  let testDb: TestDb;
  let harness: FireHarness;

  beforeEach(async () => {
    testDb = createTestDb();
    harness = await buildFireHarness(testDb);
  });

  afterEach(() => {
    harness.routineEngine.stop();
    testDb.close();
  });

  const scheduleTrigger: Trigger = {
    type: "schedule",
    tzid: "UTC",
    tzMode: "fixed",
    localTime: "09:00",
    rrule: "FREQ=DAILY",
  };

  it("repairs a run left stuck 'running' after a restart (no live process)", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "stuck",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    // Simulate the user's case: a run row orphaned in "running" by a restart,
    // with no subprocess alive to signal.
    await harness.routineRunsRepo.create({
      routineId: id,
      executionId: "exec-orphaned",
      status: "running",
    });

    const res = await harness.app.request(`/routines/${id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true, killedLiveProcess: false });

    const runs = await harness.routineRunsRepo.findByRoutineId(id);
    expect(runs[0].status).toBe("cancelled");
  });

  it("is a no-op when the latest run is already terminal", async () => {
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "done",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    const runId = await harness.routineRunsRepo.create({
      routineId: id,
      executionId: "exec-done",
      status: "running",
    });
    await harness.routineRunsRepo.updateStatus(runId, { status: "success" });

    const res = await harness.app.request(`/routines/${id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false, killedLiveProcess: false });
    // The terminal run is left untouched.
    expect((await harness.routineRunsRepo.findByRoutineId(id))[0].status).toBe("success");
  });

  it("cancels an older running run even when a newer run has already finished", async () => {
    // Runs aren't serialized per routine, so an older run can still be live after
    // a newer one finishes. Stop must reach the older one, not just the newest row.
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "overlap",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    const olderRunId = await harness.routineRunsRepo.create({
      routineId: id,
      executionId: "exec-older",
      status: "running",
    });
    const newerRunId = await harness.routineRunsRepo.create({
      routineId: id,
      executionId: "exec-newer",
      status: "running",
    });
    await harness.routineRunsRepo.updateStatus(newerRunId, { status: "success" });

    const res = await harness.app.request(`/routines/${id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: true, killedLiveProcess: false });

    const runs = await harness.routineRunsRepo.findByRoutineId(id);
    const older = runs.find((r) => r.id === olderRunId);
    const newer = runs.find((r) => r.id === newerRunId);
    expect(older?.status).toBe("cancelled");
    // The already-finished run is left as-is.
    expect(newer?.status).toBe("success");
  });

  it("does not cancel a pending_approval run (left to the approval flow)", async () => {
    // Marking it cancelled would be cosmetic — a later approval still executes
    // the action — so the stop path must leave it untouched.
    registerStubAction(harness.actionRegistry, "noop_action");
    const { id } = await createRoutineViaApi(harness.app, {
      name: "awaiting",
      trigger: scheduleTrigger,
      actionName: "noop_action",
    });
    const runId = await harness.routineRunsRepo.create({
      routineId: id,
      executionId: "exec-approval",
      status: "running",
    });
    await harness.routineRunsRepo.updateStatus(runId, { status: "pending_approval" });

    const res = await harness.app.request(`/routines/${id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: false, killedLiveProcess: false });
    expect((await harness.routineRunsRepo.findByRoutineId(id))[0].status).toBe("pending_approval");
  });

  it("returns 404 for an unknown routine", async () => {
    const res = await harness.app.request("/routines/does-not-exist/cancel", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("Routines run trace", () => {
  let testDb: TestDb;
  let app: Hono;

  beforeEach(async () => {
    testDb = createTestDb();
    const baseDeps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", routinesRoutes(baseDeps));
  });

  afterEach(() => {
    testDb.close();
  });

  // routine_runs.routineId is a FK to routines.id, so a run needs a parent row.
  async function seedRoutine(id: string) {
    await testDb.db.insert(routines).values({
      id,
      name: id,
      trigger: { type: "schedule" } as unknown,
      actionName: "compose_daily_brief",
      args: [] as unknown,
      createdAt: new Date("2026-06-22T07:00:00Z"),
    });
  }

  it("reconstructs the action tree and surfaces a child error on a success run", async () => {
    const root = "f47ac10b-58cc-4372-a567-0e02b2c3d479"; // seed rootExecutionId (no row's id equals it)
    const routineId = "rtn-brief";
    const runId = "run-1";
    await seedRoutine(routineId);

    // The run reports success (the swallowed-error bug) ...
    await testDb.db.insert(routineRuns).values({
      id: runId,
      routineId,
      executionId: root,
      status: "success",
      payload: null as unknown,
      firedAt: new Date("2026-06-22T08:00:00Z"),
      durationMs: 30625,
      error: null,
    });

    // ... while the action tree records the real failure on a child. Root has
    // a fresh id + null parentId; children point at it via parentId.
    const t0 = new Date("2026-06-22T08:00:00Z").getTime();
    const rows: Array<{
      id: string;
      parentId: string | null;
      actionName: string;
      status: "success" | "error";
      durationMs: number;
      error: string | null;
    }> = [
      {
        id: "exec-root",
        parentId: null,
        actionName: "compose_daily_brief",
        status: "success",
        durationMs: 30620,
        error: null,
      },
      {
        id: "exec-cal",
        parentId: "exec-root",
        actionName: "fetch_calendar",
        status: "success",
        durationMs: 270,
        error: null,
      },
      {
        id: "exec-ai",
        parentId: "exec-root",
        actionName: "ai_summarize",
        status: "error",
        durationMs: 30010,
        error: "model request timed out after 30000ms",
      },
      {
        id: "exec-tg",
        parentId: "exec-root",
        actionName: "send_telegram",
        status: "success",
        durationMs: 260,
        error: null,
      },
    ];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Space createdAt 1s apart so sibling ordering is deterministic despite
      // the schema's second-resolution timestamps.
      const ts = new Date(t0 + i * 1000);
      await testDb.db.insert(actionExecutions).values({
        id: r.id,
        rootExecutionId: root,
        actionName: r.actionName,
        actionType: "system",
        status: r.status,
        args: { i } as unknown,
        error: r.error,
        durationMs: r.durationMs,
        initiator: "routine:Morning Brief",
        parentId: r.parentId,
        startedAt: ts,
        finishedAt: ts,
        createdAt: ts,
      });
    }

    const res = await app.request(`/routines/${routineId}/runs/${runId}/trace`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      roots: Array<{
        actionName: string;
        status: string;
        error: string | null;
        children: Array<{ actionName: string; status: string; error: string | null }>;
      }>;
    };

    // Run header still says success ...
    expect(body.status).toBe("success");
    // ... but the reconstructed tree exposes the failing leaf.
    expect(body.roots).toHaveLength(1);
    const rootNode = body.roots[0];
    expect(rootNode.actionName).toBe("compose_daily_brief"); // found by parentId == null
    expect(rootNode.children.map((c) => c.actionName)).toEqual([
      "fetch_calendar",
      "ai_summarize",
      "send_telegram",
    ]);
    const ai = rootNode.children.find((c) => c.actionName === "ai_summarize")!;
    expect(ai.status).toBe("error");
    expect(ai.error).toBe("model request timed out after 30000ms");
  });

  it("404s when the run belongs to a different routine", async () => {
    await seedRoutine("rtn-a");
    await testDb.db.insert(routineRuns).values({
      id: "run-x",
      routineId: "rtn-a",
      executionId: "root-x",
      status: "success",
      payload: null as unknown,
      firedAt: new Date("2026-06-22T08:00:00Z"),
      durationMs: 1,
      error: null,
    });
    const res = await app.request("/routines/rtn-b/runs/run-x/trace");
    expect(res.status).toBe(404);
  });
});
