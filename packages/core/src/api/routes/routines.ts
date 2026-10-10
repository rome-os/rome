import { Hono } from "hono";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { routines } from "../../db/schema.js";
import { toRoutine } from "../../db/repositories/routines.js";
import {
  parseDateAndLocalTime,
  resolveOneOffDate,
} from "../../routines/schedule-trigger-provider.js";
import { resolveGuardianTimezone } from "../../routines/guardian-timezone.js";
import type { ApiDeps } from "../deps.js";
import type { Trigger } from "../../routines/types.js";

// The engine merges trigger payloads into action args under this key. Forbid
// it in user-supplied args so we never silently overwrite caller data.
const RESERVED_ARG_KEY = "__triggerPayload";

const LOCAL_TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const argsSchemaValidator = new Ajv2020({ allErrors: true, strict: false });
const compiledArgsSchemas = new WeakMap<Record<string, unknown>, ValidateFunction>();

/** Error when a routine names an action that isn't registered. Names the remedy
 * so the agent routes to building a workflow instead of guessing again. Kept in
 * sync with the create_routine action's copy (core can't import from rome_apps). */
function unknownActionError(actionName: string): string {
  return (
    `actionName "${actionName}" is not a registered action. ` +
    `To run multi-step work that doesn't exist yet, build it first with the ` +
    `workflow_creation skill (it registers a "<appId>_run" action), then bind the ` +
    `routine to that action. For one-shot judgement or a notification, use the ` +
    `built-in "summon" or "send_message".`
  );
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function validateActionArgs(
  actionName: string,
  args: Record<string, unknown>,
  schema: Record<string, unknown> | undefined,
): string | null {
  if (!schema) return null;

  let validator = compiledArgsSchemas.get(schema);
  if (!validator) {
    try {
      validator = argsSchemaValidator.compile(schema);
      compiledArgsSchemas.set(schema, validator);
    } catch (error) {
      return `cannot validate args for action "${actionName}": invalid input schema (${
        error instanceof Error ? error.message : String(error)
      })`;
    }
  }
  if (validator(args)) return null;
  return `args do not satisfy the input schema for action "${actionName}": ${argsSchemaValidator.errorsText(
    validator.errors,
    { dataVar: "args", separator: "; " },
  )}`;
}

/** Validates against the engine's registered providers and per-type required
 * fields. Fails closed — anything unrecognized is rejected rather than
 * silently persisted as a never-firing routine. */
function validateTrigger(trigger: Trigger, hasProvider: (type: string) => boolean): string | null {
  if (!hasProvider(trigger.type)) {
    return `trigger type "${trigger.type}" is not supported on this server`;
  }
  if (trigger.type === "schedule") {
    if (!trigger.tzid || typeof trigger.tzid !== "string") {
      return "schedule.tzid is required";
    }
    if (!trigger.localTime || !LOCAL_TIME_RE.test(trigger.localTime)) {
      return 'schedule.localTime must match "HH:mm"';
    }
    const [h, m] = trigger.localTime.split(":").map(Number);
    if (h < 0 || h > 23 || m < 0 || m > 59) {
      return "schedule.localTime hour/minute out of range";
    }
    if (trigger.date !== undefined) {
      if (typeof trigger.date !== "string" || !DATE_RE.test(trigger.date)) {
        return 'schedule.date must match "YYYY-MM-DD"';
      }
      if (trigger.rrule) {
        return "schedule.date and schedule.rrule are mutually exclusive";
      }
    }
    // Validate tzid by asking Intl whether it's a real timezone. Avoids
    // persisting "Asia/Notarealplace" and finding out at fire time.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: trigger.tzid });
    } catch {
      return `schedule.tzid "${trigger.tzid}" is not a valid IANA timezone`;
    }
    // Every schedule must declare its tz binding explicitly — the
    // type marks it required, so the API enforces it rather than persisting a
    // legacy row the read path would have to paper over.
    if (trigger.tzMode !== "fixed" && trigger.tzMode !== "floating") {
      return 'schedule.tzMode is required and must be "fixed" or "floating"';
    }
  }
  if (trigger.type === "event-bus") {
    if (!trigger.eventName || typeof trigger.eventName !== "string") {
      return "event-bus.eventName is required";
    }
  }
  return null;
}

/** Reject a dated one-off whose real fire instant has already passed. Resolves
 * date+localTime against the trigger's `tzid` — the same tz-aware
 * conversion the scheduler and create_routine use — rather than treating the
 * wall-clock as UTC, so a one-off in any zone can't slip through as a dead job. */
function datedOneOffError(trigger: {
  date?: string;
  localTime: string;
  tzid: string;
}): string | null {
  if (!trigger.date) return null;
  const fireAt = parseDateAndLocalTime(trigger.date, trigger.localTime, trigger.tzid);
  if (Number.isNaN(fireAt.getTime())) {
    return "schedule.date / localTime is unparseable";
  }
  if (fireAt.getTime() < Date.now()) {
    return "schedule.date is in the past";
  }
  return null;
}

interface CreateRoutineBody {
  name?: string;
  trigger?: Trigger;
  actionName?: string;
  args?: Record<string, unknown>;
  enabled?: boolean;
}

interface UpdateRoutineBody {
  name?: string;
  enabled?: boolean;
  trigger?: Trigger;
  actionName?: string;
  args?: Record<string, unknown>;
}

// Rebuilds the action-execution tree for a run from the flat `action_executions`
// rows that share its root executionId. Two subtleties:
//  - The root is found by `parentId == null`, NOT `id === rootExecutionId`: on
//    the routine path the root action gets a fresh id while rootExecutionId is a
//    pre-seeded group key, so no row's id equals it.
//  - `{mode:"timestamp"}` is second-resolution, so ordering siblings by
//    startedAt can tie; the build order is ascending createdAt with a stable
//    sort — best-effort for same-second siblings.

interface ActionExecutionRowLike {
  id: string;
  actionName: string;
  actionType: string | null;
  status: string;
  args: unknown;
  error: string | null;
  durationMs: number | null;
  initiator: string | null;
  actor?: unknown;
  parentId: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

/** Mirror of the web `ActionNode` shape (minus the recursive type name). */
export interface ActionTraceNode {
  id: string;
  actionName: string;
  status: string;
  durationMs: number | null;
  error: string | null;
  actionType: string | null;
  initiator: string | null;
  actor: unknown;
  args: unknown;
  startedAt: number | null;
  finishedAt: number | null;
  children: ActionTraceNode[];
}

const toEpochSeconds = (d: Date | null): number | null =>
  d ? Math.floor(d.getTime() / 1000) : null;

export function buildActionTrace(rows: ActionExecutionRowLike[]): ActionTraceNode[] {
  // Ascending createdAt so same-second siblings keep DB insertion order.
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const byId = new Map<string, ActionTraceNode>();
  for (const r of ordered) {
    byId.set(r.id, {
      id: r.id,
      actionName: r.actionName,
      status: r.status,
      durationMs: r.durationMs ?? null,
      error: r.error ?? null,
      actionType: r.actionType ?? null,
      initiator: r.initiator ?? null,
      actor: r.actor ?? null,
      args: r.args ?? null,
      startedAt: toEpochSeconds(r.startedAt),
      finishedAt: toEpochSeconds(r.finishedAt),
      children: [],
    });
  }
  const roots: ActionTraceNode[] = [];
  for (const r of ordered) {
    const node = byId.get(r.id)!;
    const parent = r.parentId ? byId.get(r.parentId) : undefined;
    // Root = no parent. An orphan (parentId set but absent from the set) is
    // reparented to root rather than silently dropped.
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortChildren = (nodes: ActionTraceNode[]) => {
    nodes.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    for (const n of nodes) sortChildren(n.children);
  };
  sortChildren(roots);
  return roots;
}

export function routinesRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // Reject binding a routine to an action that isn't registered — at both
  // create (POST) and re-bind (PATCH) time, so neither path can persist a
  // routine that errors on every fire.
  const unregisteredActionError = (actionName: string): string | null =>
    !deps.actionRegistry.has(actionName) ? unknownActionError(actionName) : null;
  const canonicalActionName = (actionName: string): string =>
    deps.actionRegistry.getCanonicalName(actionName) ?? actionName;

  // Enriches each routine with its latest run so the dashboard can render the
  // status badge (Active / Running / Failed) and the "last run failed" line
  // without a per-card request.
  app.get("/routines", async (c) => {
    const rows = await deps.db.select().from(routines);
    const latest = await deps.routineRunsRepo.findLatestByRoutineIds(rows.map((r) => r.id));
    const enriched = rows.map((row) => {
      const lr = latest.get(row.id);
      return {
        ...row,
        lastRun: lr ? { status: lr.status, firedAt: lr.firedAt } : null,
      };
    });
    return c.json(enriched);
  });

  app.post("/routines", async (c) => {
    const body = await c.req.json<CreateRoutineBody>().catch(() => ({}) as CreateRoutineBody);

    if (!body.trigger || !body.trigger.type) {
      return c.json({ error: "trigger is required" }, 400);
    }
    if (!body.actionName) {
      return c.json({ error: "actionName is required" }, 400);
    }
    // The propose_routine card toggles through here, so this also guards the
    // chat-driven path.
    const actionError = unregisteredActionError(body.actionName);
    if (actionError) {
      return c.json({ error: actionError }, 400);
    }
    if (body.args !== undefined && !isPlainObject(body.args)) {
      // Routine args are a single object; arrays / primitives are rejected
      // because the engine spreads them into the action invocation and an
      // array would silently become {0:..., 1:...}. Fan-out semantics from
      // the legacy event system are intentionally not supported.
      return c.json({ error: "args must be a plain object" }, 400);
    }
    if (body.args && RESERVED_ARG_KEY in body.args) {
      return c.json({ error: `args may not contain reserved key "${RESERVED_ARG_KEY}"` }, 400);
    }
    const resolvedActionName = canonicalActionName(body.actionName);
    const argsError = validateActionArgs(
      resolvedActionName,
      body.args ?? {},
      deps.actionRegistry.get(resolvedActionName)?.inputSchema,
    );
    if (argsError) {
      return c.json({ error: argsError }, 400);
    }
    const triggerError = validateTrigger(body.trigger, (t) => deps.routineEngine.hasProvider(t));
    if (triggerError) {
      return c.json({ error: triggerError }, 400);
    }
    body.trigger = await resolveOneOffDate(body.trigger, () =>
      resolveGuardianTimezone(deps.settingsRepo),
    );
    if (body.trigger.type === "schedule" && body.trigger.date) {
      body.trigger.tzMode = "fixed";
      const datedError = datedOneOffError(body.trigger);
      if (datedError) {
        return c.json({ error: datedError }, 400);
      }
    }

    const now = new Date();
    const record = {
      id: uuid(),
      name: body.name ?? "",
      enabled: body.enabled ?? true,
      trigger: body.trigger as unknown,
      actionName: resolvedActionName,
      args: (body.args ?? {}) as unknown,
      createdAt: now,
      lastFiredAt: null,
      nextRunAt: null,
    };

    await deps.db.insert(routines).values(record);
    const [inserted] = await deps.db.select().from(routines).where(eq(routines.id, record.id));

    if (inserted?.enabled) {
      await deps.routineEngine.activate(toRoutine(inserted));
    }

    return c.json(inserted, 201);
  });

  app.patch("/routines/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<UpdateRoutineBody>().catch(() => ({}) as UpdateRoutineBody);

    if (body.args !== undefined) {
      if (!isPlainObject(body.args)) {
        return c.json({ error: "args must be a plain object" }, 400);
      }
      if (RESERVED_ARG_KEY in body.args) {
        return c.json({ error: `args may not contain reserved key "${RESERVED_ARG_KEY}"` }, 400);
      }
    }
    if (body.trigger !== undefined) {
      if (!body.trigger.type) {
        return c.json({ error: "trigger.type is required" }, 400);
      }
      const triggerError = validateTrigger(body.trigger, (t) => deps.routineEngine.hasProvider(t));
      if (triggerError) {
        return c.json({ error: triggerError }, 400);
      }
      body.trigger = await resolveOneOffDate(body.trigger, () =>
        resolveGuardianTimezone(deps.settingsRepo),
      );
      // A dated one-off pins to a fixed absolute zone, same as POST,
      // and must not be re-pointed to an already-past instant.
      if (body.trigger.type === "schedule" && body.trigger.date) {
        body.trigger.tzMode = "fixed";
        const datedError = datedOneOffError(body.trigger);
        if (datedError) {
          return c.json({ error: datedError }, 400);
        }
      }
    }
    // Re-binding to an unregistered action would recreate the zombie the POST
    // guard prevents, so validate the new actionName here too.
    if (body.actionName !== undefined) {
      const actionError = unregisteredActionError(body.actionName);
      if (actionError) {
        return c.json({ error: actionError }, 400);
      }
    }
    if (body.actionName !== undefined || body.args !== undefined) {
      const [current] = await deps.db.select().from(routines).where(eq(routines.id, id));
      if (!current) {
        return c.json({ error: "Routine not found" }, 404);
      }
      const actionName = canonicalActionName(body.actionName ?? current.actionName);
      const args = body.args ?? toRoutine(current).args;
      const argsError = validateActionArgs(
        actionName,
        args,
        deps.actionRegistry.get(actionName)?.inputSchema,
      );
      if (argsError) {
        return c.json({ error: argsError }, 400);
      }
    }

    // Turning a one-off back on after its date has passed would leave it
    // enabled with nothing left to fire.
    if (body.enabled === true && body.trigger === undefined) {
      const [current] = await deps.db.select().from(routines).where(eq(routines.id, id));
      const trigger = current ? toRoutine(current).trigger : undefined;
      const datedError = trigger?.type === "schedule" ? datedOneOffError(trigger) : null;
      if (datedError === "schedule.date is in the past" && trigger?.type === "schedule") {
        return c.json(
          {
            error: `This one-off was set for ${trigger.date} at ${trigger.localTime}, which has passed. Create a new routine to run it again.`,
          },
          400,
        );
      }
      if (datedError) {
        return c.json({ error: datedError }, 400);
      }
    }

    const updates: Record<string, unknown> = {};
    if (body.name !== undefined) updates.name = body.name;
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.trigger !== undefined) updates.trigger = body.trigger;
    if (body.actionName !== undefined) updates.actionName = canonicalActionName(body.actionName);
    if (body.args !== undefined) updates.args = body.args;

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const result = await deps.db.update(routines).set(updates).where(eq(routines.id, id));
    if (Number(result.changes ?? 0) === 0) {
      return c.json({ error: "Routine not found" }, 404);
    }

    const [updated] = await deps.db.select().from(routines).where(eq(routines.id, id));

    if (updated) {
      await deps.routineEngine.deactivate(id);
      if (updated.enabled) {
        await deps.routineEngine.activate(toRoutine(updated));
      }
    }

    return c.json(updated);
  });

  // This is the guardian/dashboard path, so it never authorizes a managed
  // routine: `deleteIfNoActiveRuns` is called with no actor, refusing (403) any
  // routine an app owns. The repo also gates on in-flight runs and clears run
  // history in one transaction, so we only tear the trigger down once the row
  // is actually gone.
  app.delete("/routines/:id", async (c) => {
    const id = c.req.param("id");

    const result = await deps.routinesRepo.deleteIfNoActiveRuns(id);
    switch (result.status) {
      case "not-found":
        return c.json({ error: "Routine not found" }, 404);
      case "managed":
        return c.json(
          {
            error: `This routine is managed by the "${result.managedBy}" app and can't be deleted here.`,
          },
          403,
        );
      case "active-runs":
        return c.json(
          {
            error: `Routine has ${result.activeRuns} active run(s); wait for them to finish or cancel them first.`,
          },
          409,
        );
      case "deleted":
        await deps.routineEngine.deactivate(id);
        return c.json({ ok: true });
    }
  });

  // Fires the routine's action immediately ("try run now"). Real execution, out
  // of band from the trigger: the run is recorded in history like a scheduled
  // fire. A failed action is NOT an HTTP error — the request succeeded; the
  // caller reads `status` from the body to tell success from a run-level
  // failure.
  app.post("/routines/:id/run", async (c) => {
    const id = c.req.param("id");
    // Optional trigger payload — lets a manual routine be run with input. Absent
    // or non-object body means a bare fire (empty payload), matching "try run now".
    let payload: Record<string, unknown> = {};
    const body = await c.req.json().catch(() => null);
    if (body && typeof body === "object" && typeof body.payload === "object" && body.payload) {
      payload = body.payload as Record<string, unknown>;
    }
    try {
      const outcome = await deps.routineEngine.runNow(id, payload);
      return c.json(outcome);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("routine not found")) {
        return c.json({ error: "Routine not found" }, 404);
      }
      throw err;
    }
  });

  // Kills a live execution if one exists in this process, and always repairs
  // the persisted status to "cancelled" so a run left stuck "running" by a
  // restart clears.
  app.post("/routines/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const routine = await deps.routinesRepo.findById(id);
    if (!routine) {
      return c.json({ error: "Routine not found" }, 404);
    }
    const result = await deps.routineEngine.cancelRun(id);
    return c.json(result);
  });

  app.get("/routines/:id/runs", async (c) => {
    const id = c.req.param("id");
    const limit = parseInt(c.req.query("limit") ?? "20", 10);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);

    const runs = await deps.routineRunsRepo.findByRoutineId(id, {
      limit,
      offset,
    });
    return c.json(runs);
  });

  // Lazy-loaded when a run row is expanded.
  app.get("/routines/:id/runs/:runId/trace", async (c) => {
    const id = c.req.param("id");
    const runId = c.req.param("runId");
    const run = await deps.routineRunsRepo.findById(runId);
    if (!run || run.routineId !== id) {
      return c.json({ error: "Run not found" }, 404);
    }
    const rows = await deps.actionExecutionsRepo.findByRootExecutionIds([run.executionId]);
    return c.json({
      runId: run.id,
      status: run.status,
      error: run.error ?? null,
      roots: buildActionTrace(rows),
    });
  });

  return app;
}
