import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";

// The downgrade case below is expected to log an error. Mocking keeps it off
// the suite's stderr and gives the test a handle to assert it fires.
const logError = rs.hoisted(() => rs.fn());
rs.mock("../logger.js", () => ({
  createLogger: () => ({ error: logError, info: rs.fn(), warn: rs.fn(), debug: rs.fn() }),
}));

import { getDb, resetDb, type DatabaseConfig } from "./index.js";
import { getSystemMigrationsPath, isMigrateCliEntrypoint, runMigrations } from "./migrate.js";

describe("getSystemMigrationsPath", () => {
  const originalProjectRoot = process.env.ROME_PROJECT_ROOT;

  afterEach(() => {
    if (originalProjectRoot === undefined) {
      delete process.env.ROME_PROJECT_ROOT;
      return;
    }
    process.env.ROME_PROJECT_ROOT = originalProjectRoot;
  });

  it("resolves from the configured core root", () => {
    process.env.ROME_PROJECT_ROOT = "/app";

    expect(getSystemMigrationsPath()).toBe("/app/packages/core/drizzle/system");
  });
});

describe("isMigrateCliEntrypoint", () => {
  it("matches source and compiled migration entrypoints", () => {
    expect(isMigrateCliEntrypoint(["node", "src/db/migrate.ts"])).toBe(true);
    expect(isMigrateCliEntrypoint(["node", "dist/db/migrate.js"])).toBe(true);
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/src/db/migrate.ts"])).toBe(true);
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/dist/db/migrate.js"])).toBe(true);
  });

  it("does not match bundled core entrypoints", () => {
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/dist/index.js"])).toBe(false);
    expect(isMigrateCliEntrypoint(["node", "/app/packages/core/dist/daemon/index.js"])).toBe(false);
  });
});

describe("runMigrations on a database a newer release migrated", () => {
  let dir: string;
  let config: DatabaseConfig;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rome-migrate-"));
    config = { type: "sqlite", sqlitePath: join(dir, "rome.db") };
    resetDb();
    logError.mockClear();
  });

  afterEach(() => {
    // DrizzleDb's type omits the driver handle drizzle() attaches.
    (getDb(config) as unknown as { $client: { close(): void } }).$client.close();
    resetDb();
    rmSync(dir, { recursive: true, force: true });
  });

  function newestShippedMigrationMillis(): number {
    const journal = JSON.parse(
      readFileSync(join(getSystemMigrationsPath(), "meta", "_journal.json"), "utf8"),
    ) as { entries: { when: number }[] };
    return Math.max(...journal.entries.map((entry) => entry.when));
  }

  it("reports nothing on a fresh database or a re-run on the same build", async () => {
    expect(await runMigrations(config)).toEqual({ databaseAheadBy: 0 });
    expect(await runMigrations(config)).toEqual({ databaseAheadBy: 0 });
    expect(logError).not.toHaveBeenCalled();
  });

  it("counts the migrations this build does not ship and logs an error instead of throwing", async () => {
    await runMigrations(config);
    // What a newer release leaves behind: a migration row dated after every
    // migration this build ships.
    getDb(config).run(
      sql`INSERT INTO __drizzle_migrations_system (hash, created_at) VALUES ('from-a-newer-release', ${newestShippedMigrationMillis() + 1})`,
    );

    await expect(runMigrations(config)).resolves.toEqual({ databaseAheadBy: 1 });
    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[1]).toMatchObject({ databaseAheadBy: 1 });
  });
});
