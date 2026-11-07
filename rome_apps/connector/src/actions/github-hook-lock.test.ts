import { resolve } from "node:path";
import { describe, expect, it } from "@rstest/core";
import type { AppDbContext } from "@rome-os/app-runtime";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { settings } from "../db/schema.js";
import { withGithubHookLock } from "./github-hook-lock.js";

function makeDb(): Pick<AppDbContext, "connection"> {
  const conn = drizzle(new Database(":memory:")) as unknown as BetterSQLite3Database<
    Record<string, never>
  >;
  migrate(conn, {
    migrationsFolder: resolve(__dirname, "../db/migrations"),
    migrationsTable: "__drizzle_migrations_app_connector",
  });
  return { connection: conn } as Pick<AppDbContext, "connection">;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withGithubHookLock", () => {
  it("keeps two writers to one repo's webhook from dropping each other's events", async () => {
    const db = makeDb();
    // The hook as GitHub holds it; each writer reads it, merges, and writes back.
    let hookEvents: string[] = ["push"];
    const subscribe = (event: string) =>
      withGithubHookLock(
        db,
        { repo: "acme/widgets" },
        async () => {
          const read = [...hookEvents];
          await sleep(20);
          hookEvents = [...new Set([...read, event])];
        },
        { retryMs: 5 },
      );
    await Promise.all([subscribe("workflow_run"), subscribe("pull_request")]);
    expect(hookEvents.sort()).toEqual(["pull_request", "push", "workflow_run"]);
    // The lock is released afterwards.
    expect(await db.connection.select().from(settings)).toEqual([]);
  });

  it("does not hold up a writer to another repo, and frees the lock when the task throws", async () => {
    const db = makeDb();
    const order: string[] = [];
    const slow = withGithubHookLock(db, { repo: "acme/a" }, async () => {
      await sleep(50);
      order.push("a");
      throw new Error("GitHub said no");
    });
    await withGithubHookLock(db, { org: "acme" }, async () => void order.push("org"));
    await expect(slow).rejects.toThrow("GitHub said no");
    expect(order).toEqual(["org", "a"]);
    expect(await db.connection.select().from(settings)).toEqual([]);
  });

  it("takes over a lease its holder never released", async () => {
    const db = makeDb();
    await db.connection.insert(settings).values({
      key: "lock:github-hook:repo:acme/widgets",
      value: "a dead worker",
      updatedAt: new Date(Date.now() - 120_000),
    });
    expect(await withGithubHookLock(db, { repo: "Acme/Widgets" }, async () => "ran")).toBe("ran");
  });

  it("gives up with a reason when another writer keeps the lock", async () => {
    const db = makeDb();
    const held = withGithubHookLock(db, { repo: "acme/widgets" }, () => sleep(100));
    await expect(
      withGithubHookLock(db, { repo: "acme/widgets" }, async () => "ran", {
        waitMs: 20,
        retryMs: 5,
      }),
    ).rejects.toThrow("Another change to this GitHub webhook is still running");
    await held;
  });
});
