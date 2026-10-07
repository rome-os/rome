import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { RomeAppApiRequest, RomeAppCaller, RomeAppContext } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../../../../packages/core/src/test/helpers.js";
import { createRunsRepository } from "../db/repositories/runs.js";
import type { RunDetail, RunListItem } from "../lib/run-view.js";
import { createApiHandler } from "./index.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../db/migrations");
const MEMORY = "/home/rome/.rome/default/memory";

let testDb: TestDb;

beforeEach(() => {
  testDb = createTestDb();
  migrate(testDb.db as never, {
    migrationsFolder: MIGRATIONS_DIR,
    migrationsTable: "__drizzle_migrations_app_dream",
  });
});

afterEach(() => {
  testDb.close();
});

const appDb = () => ({
  connection: testDb.db,
  tablePrefix: "dream",
  tableName: (name: string) => `dream__${name}`,
});

function handler(overrides: Partial<RomeAppContext> = {}) {
  return createApiHandler({
    app: { id: "dream", version: "0.0.0" },
    db: appDb(),
    runAction: rs.fn().mockResolvedValue({ executionId: "exec-1" }),
    listRoutines: rs.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as RomeAppContext);
}

const guardian: RomeAppCaller = { kind: "guardian", userId: "u1", via: "cookie" };

function request(
  method: string,
  path: string,
  caller: RomeAppCaller = guardian,
): RomeAppApiRequest {
  const [route, query] = path.split("?");
  return {
    method,
    path: route.split("/"),
    headers: {},
    query: new URLSearchParams(query),
    caller,
  } as RomeAppApiRequest;
}

function seedDream(): string {
  const runs = createRunsRepository(appDb());
  const id = runs.start({ kind: "dream", windowHours: 24 });
  runs.addChanges(id, [
    {
      op: "edit",
      path: `${MEMORY}/MEMORY.md`,
      content: "- Prefers short replies",
      previous: "",
      truncated: false,
    },
    {
      op: "edit",
      path: `${MEMORY}/MEMORY.md`,
      content: "- Lives in Lisbon",
      previous: "",
      truncated: false,
    },
    {
      op: "write",
      path: `${MEMORY}/journal/2026/10/06.md`,
      content: "# Journal",
      previous: null,
      truncated: false,
    },
  ]);
  runs.finish(id, { status: "completed", summary: "Updated memory." });
  return id;
}

describe("dream API", () => {
  it("lists runs with what each one produced", async () => {
    seedDream();
    const runs = createRunsRepository(appDb());
    const review = runs.start({
      kind: "skill_review",
      reviewedSessionId: "s1",
      reviewedSessionName: "Deploy",
    });
    runs.addChanges(review, [
      {
        op: "write",
        path: "/repo/rome_apps/coding/src/skills/deploy/SKILL.md",
        content: "# Deploy",
        previous: null,
        truncated: false,
      },
    ]);
    runs.finish(review, { status: "completed", summary: "Saved." });

    const res = await handler().handle(request("GET", "runs"));
    const body = (await res.json()) as { runs: RunListItem[] };

    expect(body.runs.map((r) => [r.kind, r.outcome])).toEqual([
      [
        "skill_review",
        {
          journal: false,
          memoryFiles: 0,
          skills: [{ name: "deploy", op: "write" }],
          otherFiles: 0,
        },
      ],
      ["dream", { journal: true, memoryFiles: 1, skills: [], otherFiles: 0 }],
    ]);
    expect(body.runs[0]?.reviewedSession).toEqual({ id: "s1", name: "Deploy" });
  });

  it("filters runs by kind", async () => {
    seedDream();
    createRunsRepository(appDb()).start({ kind: "skill_review", reviewedSessionId: "s1" });

    const res = await handler().handle(request("GET", "runs?kind=dream"));
    const body = (await res.json()) as { runs: RunListItem[] };

    expect(body.runs.map((r) => r.kind)).toEqual(["dream"]);
  });

  it("returns a run with its changes grouped by file", async () => {
    const id = seedDream();

    const res = await handler().handle(request("GET", `runs/${id}`));
    const { run } = (await res.json()) as { run: RunDetail };

    expect(run.summary).toBe("Updated memory.");
    expect(run.files.map((f) => [f.area, f.memoryFile, f.changes.length])).toEqual([
      ["memory", "MEMORY.md", 2],
      ["journal", "journal/2026/10/06.md", 1],
    ]);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await handler().handle(request("GET", "runs/missing"));
    expect(res.status).toBe(404);
  });

  it("starts a dream by creating its run, then dispatching the action detached", async () => {
    const runAction = rs.fn().mockResolvedValue({ executionId: "exec-1" });

    const res = await handler({ runAction } as Partial<RomeAppContext>).handle(
      request("POST", "runs/dream"),
    );
    const { runId } = (await res.json()) as { runId: string };

    expect(res.status).toBe(202);
    expect(createRunsRepository(appDb()).byId(runId)?.status).toBe("queued");
    expect(runAction).toHaveBeenCalledWith("dream:dream", { runId }, { detached: true });
  });

  it("refuses a second dream while one is running", async () => {
    const running = createRunsRepository(appDb()).start({ kind: "dream", windowHours: 24 });

    const res = await handler().handle(request("POST", "runs/dream"));

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ runId: running });
  });

  it("marks the run failed when the dispatch is rejected", async () => {
    const runAction = rs.fn().mockRejectedValue(new Error("worker unavailable"));

    const res = await handler({ runAction } as Partial<RomeAppContext>).handle(
      request("POST", "runs/dream"),
    );

    expect(res.status).toBe(503);
    const [run] = createRunsRepository(appDb()).listRecent({ limit: 1 });
    expect(run).toMatchObject({ status: "failed", error: "worker unavailable" });
  });

  it("lets only the guardian start a dream", async () => {
    const res = await handler().handle(request("POST", "runs/dream", { kind: "anonymous" }));
    expect(res.status).toBe(403);
  });

  it("reports a run left running past the stale window as interrupted", async () => {
    const runs = createRunsRepository(appDb());
    const id = runs.start({ kind: "dream", windowHours: 24 });
    const now = Date.now();
    rs.spyOn(Date, "now").mockReturnValue(now + 2 * 60 * 60 * 1000);

    try {
      const res = await handler().handle(request("GET", `runs/${id}`));
      const { run } = (await res.json()) as { run: RunDetail };
      expect(run.status).toBe("interrupted");
    } finally {
      rs.restoreAllMocks();
    }
  });

  it("reads the next nightly dream from its routine", async () => {
    const nextRunAt = new Date("2026-10-07T03:00:00Z");
    const listRoutines = rs.fn().mockResolvedValue([
      { name: "daily-dream", enabled: true, nextRunAt },
      { name: "other", enabled: true, nextRunAt: new Date() },
    ]);

    const res = await handler({ listRoutines } as Partial<RomeAppContext>).handle(
      request("GET", "schedule"),
    );

    expect(await res.json()).toEqual({ enabled: true, nextRunAt: nextRunAt.toISOString() });
  });
});
