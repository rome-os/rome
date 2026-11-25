import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { routines } from "../../db/schema.js";
import { publicRoutineRow } from "../../db/repositories/routines.js";
import { ownerOfChat } from "../../webchat/owner.js";
import { callerOwner } from "./concierge.js";
import { resolveOneOffDate } from "../../routines/schedule-trigger-provider.js";
import { resolveGuardianTimezone } from "../../instance/timezone.js";
import type { ApiDeps } from "../deps.js";
import { CHAT_ROUTINE_KEY_PREFIX } from "../../routines/chat-routine-key.js";
import type { Trigger } from "../../routines/types.js";
import { createRoutine } from "../../routines/create.js";
import { listRoutinesWithLastRun } from "../../routines/list.js";
import { listRoutineRuns, readRoutineRun } from "../../routines/runs.js";
import { updateRoutine } from "../../routines/update.js";

interface CreateRoutineBody {
  name?: string;
  trigger?: Trigger;
  actionName?: string;
  args?: Record<string, unknown>;
  enabled?: boolean;
  /** Optional caller-assigned identity (the unique `routines.key`). A chat
   * routine card sends the key minted with it, so retries and reloads find the
   * routine it created instead of matching by name. */
  key?: string;
  /** The chat whose card turns it on: the caller's own, where it was made. */
  chatId?: string;
}

const MAX_ROUTINE_KEY_LENGTH = 200;
// Keys this route may assign start with CHAT_ROUTINE_KEY_PREFIX. Apps may key
// their own managed routines through create_routine; keeping this route to its
// own prefix stops a chat card from claiming, or being answered with, one of
// those.

interface UpdateRoutineBody {
  name?: string;
  enabled?: boolean;
}

export function routinesRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // Enriches each routine with its latest run so the dashboard can render the
  // status badge (Active / Running / Failed) and the "last run failed" line
  // without a per-card request.
  app.get("/routines", async (c) => {
    const listed = await listRoutinesWithLastRun({
      routines: deps.routinesRepo,
      routineRuns: deps.routineRunsRepo,
    });
    return c.json(
      listed.map(({ row, lastRun }) => ({
        ...publicRoutineRow(row),
        lastRun: lastRun ? { status: lastRun.status, firedAt: lastRun.firedAt } : null,
      })),
    );
  });

  app.post("/routines", async (c) => {
    const body = await c.req.json<CreateRoutineBody>().catch(() => ({}) as CreateRoutineBody);

    if (
      body.key !== undefined &&
      (typeof body.key !== "string" ||
        !body.key.startsWith(CHAT_ROUTINE_KEY_PREFIX) ||
        body.key.length <= CHAT_ROUTINE_KEY_PREFIX.length ||
        body.key.length > MAX_ROUTINE_KEY_LENGTH)
    ) {
      return c.json(
        {
          error: `key must start with "${CHAT_ROUTINE_KEY_PREFIX}" and be at most ${MAX_ROUTINE_KEY_LENGTH} characters`,
        },
        400,
      );
    }
    // A key that already names a routine means this create already happened
    // (a retried click, a second tab). Answer 409 with the existing id so the
    // caller can link to it rather than creating a duplicate. Checked before
    // the create-time validation below, which can change after creation (a
    // dated one-off's date passes, an action is uninstalled).
    const existingIdForKey = async (key: string | undefined): Promise<string | undefined> =>
      key === undefined ? undefined : (await deps.routinesRepo.findByKey(key))?.id;
    const keyTaken = (id: string) =>
      c.json({ error: "A routine with this key already exists", id }, 409);
    const takenId = await existingIdForKey(body.key);
    if (takenId) return keyTaken(takenId);

    let madeIn: string | undefined;
    if (body.chatId !== undefined) {
      const chatOwner =
        typeof body.chatId === "string" && body.chatId
          ? await (deps.concierge
              ? deps.concierge.ownerOfChat(body.chatId)
              : ownerOfChat((id) => deps.webchatRepo.getSession(id), body.chatId))
          : null;
      if (chatOwner !== callerOwner(c)) return c.json({ error: "No such chat" }, 404);
      madeIn = body.chatId;
    }

    let result: Awaited<ReturnType<typeof createRoutine>>;
    try {
      // The one creation path, so the routine works for the right chat
      // (routineChatOf) and acts for the person turning it on, from Settings
      // or a chat's card.
      result = await createRoutine(
        {
          name: body.name,
          ...(body.key !== undefined ? { key: body.key } : {}),
          trigger: body.trigger,
          actionName: body.actionName,
          ...(body.args !== undefined ? { args: body.args } : {}),
          enabled: body.enabled ?? true,
        },
        {
          routinesRepo: deps.routinesRepo,
          routineEngine: deps.routineEngine,
          actionRegistry: deps.actionRegistry,
          resolveOneOffDate: (trigger) =>
            resolveOneOffDate(trigger, () => resolveGuardianTimezone(deps.settingsRepo)),
          hasTriggerType: (type) => deps.routineEngine.hasProvider(type),
        },
        { kind: "person", ...(madeIn ? { madeIn } : {}) },
      );
    } catch (err) {
      // Lost a race with a concurrent create of the same key: the UNIQUE
      // constraint is the backstop for the check above.
      const existingId = await existingIdForKey(body.key);
      if (existingId) return keyTaken(existingId);
      throw err;
    }
    if (result.status === "error") {
      if (result.existingId) return keyTaken(result.existingId);
      return c.json({ error: result.error }, 400);
    }
    const id = result.data.routineId;
    const [inserted] = await deps.db.select().from(routines).where(eq(routines.id, id));

    return c.json(inserted ? publicRoutineRow(inserted) : inserted, 201);
  });

  // The dashboard only toggles and renames, so PATCH accepts just those two
  // fields and needs none of POST's trigger, action or args validation.
  app.patch("/routines/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<UpdateRoutineBody>().catch(() => ({}) as UpdateRoutineBody);

    const unsupported = Object.keys(body).filter((key) => key !== "name" && key !== "enabled");
    if (unsupported.length > 0) {
      return c.json(
        { error: `Only name and enabled can be updated (got ${unsupported.join(", ")})` },
        400,
      );
    }

    if (body.name === undefined && body.enabled === undefined) {
      return c.json({ error: "No fields to update" }, 400);
    }

    const result = await updateRoutine(
      { routines: deps.routinesRepo, engine: deps.routineEngine },
      id,
      {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    );
    if (result.status === "not-found") return c.json({ error: "Routine not found" }, 404);
    if (result.status === "refused") return c.json({ error: result.error }, 400);
    const [updated] = await deps.db.select().from(routines).where(eq(routines.id, id));
    return c.json(updated ? publicRoutineRow(updated) : updated);
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
  // the persisted status to "cancelled" so a "running" run with no live
  // process clears.
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
    return c.json(
      await listRoutineRuns({ routineRuns: deps.routineRunsRepo }, id, { limit, offset }),
    );
  });

  // Lazy-loaded when a run row is expanded.
  app.get("/routines/:id/runs/:runId/trace", async (c) => {
    const detail = await readRoutineRun(
      { routineRuns: deps.routineRunsRepo, actionExecutions: deps.actionExecutionsRepo },
      c.req.param("id"),
      c.req.param("runId"),
    );
    if (!detail) return c.json({ error: "Run not found" }, 404);
    return c.json(detail);
  });

  return app;
}
