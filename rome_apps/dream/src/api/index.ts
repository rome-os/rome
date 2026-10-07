import type { RomeAppApiHandler, RomeAppApiRequest, RomeAppContext } from "@rome-os/app-runtime";
import { createRunsRepository, type RunKind } from "../db/repositories/runs.js";
import { STALE_RUN_MS, toDetail, toListItem, type DreamSchedule } from "../lib/run-view.js";

/** Name `dream` registers its daily routine under. */
const DREAM_ROUTINE_NAME = "daily-dream";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

function parseKind(value: string | null): RunKind | undefined {
  return value === "dream" || value === "skill_review" ? value : undefined;
}

function parseLimit(value: string | null): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

class DreamApiHandler implements RomeAppApiHandler {
  constructor(private readonly ctx: RomeAppContext) {}

  async handle(request: RomeAppApiRequest): Promise<Response> {
    const [head, id, ...rest] = request.path;
    const runs = createRunsRepository(this.ctx.db);
    const now = Date.now();

    // GET /runs?kind=dream|skill_review&limit=N
    if (request.method === "GET" && head === "runs" && id === undefined) {
      const list = runs.listRecent({
        kind: parseKind(request.query.get("kind")),
        limit: parseLimit(request.query.get("limit")),
      });
      const changes = runs.changePaths(list.map((run) => run.id));
      return json({ runs: list.map((run) => toListItem(run, changes.get(run.id) ?? [], now)) });
    }

    // POST /runs/dream — start a dream now. The run record exists before the
    // action does, so the page can open it straight away.
    if (request.method === "POST" && head === "runs" && id === "dream" && rest.length === 0) {
      if (request.caller.kind !== "guardian") {
        return json({ error: "forbidden" }, { status: 403 });
      }
      const running = runs.latestRunning("dream");
      if (running && now - running.startedAt.getTime() <= STALE_RUN_MS) {
        return json({ error: "already_running", runId: running.id }, { status: 409 });
      }
      const runId = runs.start({ kind: "dream", windowHours: 24 });
      try {
        await this.ctx.runAction("dream:dream", { runId }, { detached: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        runs.finish(runId, { status: "failed", error: message });
        return json({ error: "dispatch_failed", message }, { status: 503 });
      }
      return json({ runId }, { status: 202 });
    }

    // GET /runs/:id
    if (request.method === "GET" && head === "runs" && id && rest.length === 0) {
      const run = runs.byId(id);
      if (!run) return json({ error: "not_found" }, { status: 404 });
      return json({ run: toDetail(run, runs.changes(run.id), now) });
    }

    // GET /schedule — when the next nightly dream runs.
    if (request.method === "GET" && head === "schedule" && id === undefined) {
      const routines = await this.ctx.listRoutines();
      const routine = routines.find((r) => r.name === DREAM_ROUTINE_NAME);
      const schedule: DreamSchedule = {
        enabled: routine?.enabled ?? false,
        nextRunAt:
          routine?.enabled && routine.nextRunAt ? new Date(routine.nextRunAt).toISOString() : null,
      };
      return json(schedule);
    }

    return json({ error: "not_found" }, { status: 404 });
  }
}

export function createApiHandler(ctx: RomeAppContext): RomeAppApiHandler {
  return new DreamApiHandler(ctx);
}
