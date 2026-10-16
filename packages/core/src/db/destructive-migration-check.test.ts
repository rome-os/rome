import { describe, expect, it } from "@rstest/core";
import {
  findDeclaredRemovals,
  type MigrationSql,
  type SchemaSnapshot,
} from "./destructive-migration-check.js";

type Tables = Record<string, string[]>;

function snapshot(tables: Tables): SchemaSnapshot {
  return {
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, columns]) => [
        name,
        { columns: Object.fromEntries(columns.map((column) => [column, { name: column }])) },
      ]),
    ),
  };
}

/** A shipped migration that creates `tables`, as the last release left the database. */
function shippedSchema(tables: Tables): MigrationSql {
  return {
    name: "0000_shipped",
    shipped: true,
    sql: Object.entries(tables)
      .map(
        ([table, columns]) =>
          `CREATE TABLE \`${table}\` (${columns.map((column) => `\`${column}\` text`).join(", ")});`,
      )
      .join("\n--> statement-breakpoint\n"),
  };
}

function migration(name: string, ...statements: string[]): MigrationSql {
  return { name, shipped: false, sql: statements.join("\n--> statement-breakpoint\n") };
}

/** The last release declares and created `tables`, then `migrations` run on top. */
function check(tables: Tables, ...migrations: MigrationSql[]) {
  return findDeclaredRemovals({
    shippedSnapshot: snapshot(tables),
    migrations: [shippedSchema(tables), ...migrations],
  });
}

describe("findDeclaredRemovals", () => {
  it("flags a dropped table the last release still declares", () => {
    // The shape v1.1.146 shipped and v1.1.147 removed, reduced to what the check reads.
    const removals = check(
      { settings: ["key", "value"], provider_accounts: ["id", "provider", "token"] },
      migration(
        "0072_drop_provider_accounts",
        "DROP TABLE `provider_accounts`;",
        "DELETE FROM `settings` WHERE `key` = 'telegram';",
      ),
    );

    expect(removals).toEqual([
      { table: "provider_accounts", migration: "0072_drop_provider_accounts" },
    ]);
  });

  it("passes a drop once the last release stopped declaring the table", () => {
    const removals = findDeclaredRemovals({
      shippedSnapshot: snapshot({ settings: ["key"] }),
      migrations: [
        shippedSchema({ settings: ["key"], provider_accounts: ["id"] }),
        migration("0073_drop_provider_accounts", "DROP TABLE `provider_accounts`;"),
      ],
    });

    expect(removals).toEqual([]);
  });

  it("passes the release that stops declaring an object while a no-op migration keeps it", () => {
    expect(
      check({ routines: ["id", "legacy_trigger"] }, migration("0074_keep", "SELECT 1;")),
    ).toEqual([]);
  });

  it("flags dropped and renamed columns the last release declares", () => {
    const removals = check(
      { outbox: ["id", "payload", "legacy_target"] },
      migration("0075_drop", "ALTER TABLE `outbox` DROP COLUMN `legacy_target`;"),
      migration("0076_rename", 'ALTER TABLE "outbox" RENAME COLUMN "payload" TO "body";'),
    );

    expect(removals).toEqual([
      { table: "outbox", column: "payload", migration: "0076_rename" },
      { table: "outbox", column: "legacy_target", migration: "0075_drop" },
    ]);
  });

  it("flags a renamed table as the removal of its old name", () => {
    const removals = check(
      { events: ["id"] },
      migration("0077_rename_events", "ALTER TABLE `events` RENAME TO `routines`;"),
    );

    expect(removals).toEqual([{ table: "events", migration: "0077_rename_events" }]);
  });

  it("counts a table dropped and created again by a later migration as kept", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration("0078_drop", "DROP TABLE `routines`;"),
      migration("0079_create", "CREATE TABLE `routines` (`id` text, `name` text);"),
    );

    expect(removals).toEqual([]);
  });

  it("is not fooled by SQL inside string literals", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0080_custom",
        "SELECT 'INSERT INTO copy (id, name) SELECT id, name FROM routines';",
        "DROP TABLE routines;",
        "SELECT 'ALTER TABLE copy RENAME TO routines';",
      ),
    );

    expect(removals).toEqual([{ table: "routines", migration: "0080_custom" }]);
  });

  it("ignores dropped indexes, which no older reader depends on", () => {
    const removals = check(
      { rome_sessions: ["id", "type"] },
      migration(
        "0081_drop_index",
        "CREATE INDEX `rome_sessions_type_idx` ON `rome_sessions` (`type`);",
        "DROP INDEX IF EXISTS `rome_sessions_type_idx`;",
        "UPDATE `rome_sessions` SET `type` = 'channel';",
      ),
    );

    expect(removals).toEqual([]);
  });

  it("ignores tables the last release did not declare", () => {
    const removals = check(
      { settings: ["key"] },
      migration("0082_scratch", "CREATE TABLE `scratch` (`id` text);", "DROP TABLE `scratch`;"),
    );

    expect(removals).toEqual([]);
  });

  it("ignores a declared object the shipped migrations never created", () => {
    const removals = findDeclaredRemovals({
      shippedSnapshot: snapshot({ settings: ["key", "never_created"] }),
      migrations: [shippedSchema({ settings: ["key"] }), migration("0083_noop", "SELECT 1;")],
    });

    expect(removals).toEqual([]);
  });

  it("names a migration that fails to run, as drizzle's migrator would fail on it", () => {
    expect(() =>
      check({ settings: ["key"] }, migration("0084_comment_only", "-- nothing to run")),
    ).toThrow("migration 0084_comment_only failed");
  });
});

describe("findDeclaredRemovals on table rebuilds", () => {
  const drizzleRebuild = (copied: string) =>
    migration(
      "0085_rebuild_routines",
      "PRAGMA foreign_keys=OFF;",
      "CREATE TABLE `__new_routines` (`id` text PRIMARY KEY NOT NULL, `name` text, `paused` integer DEFAULT 0 NOT NULL);",
      `INSERT INTO \`__new_routines\`(${copied}) SELECT ${copied} FROM \`routines\`;`,
      "DROP TABLE `routines`;",
      "ALTER TABLE `__new_routines` RENAME TO `routines`;",
      "PRAGMA foreign_keys=ON;",
    );

  it("passes a drizzle rebuild that keeps every shipped column", () => {
    expect(check({ routines: ["id", "name"] }, drizzleRebuild('"id", "name"'))).toEqual([]);
  });

  it("flags a column a drizzle rebuild leaves out", () => {
    expect(
      check({ routines: ["id", "name", "legacy_trigger"] }, drizzleRebuild('"id", "name"')),
    ).toEqual([
      { table: "routines", column: "legacy_trigger", migration: "0085_rebuild_routines" },
    ]);
  });

  it("flags a column a hand-written rebuild drops from its copy", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0086_rebuild_routines",
        "CREATE TABLE `copy` (`id` text, `name` text);",
        'INSERT INTO `copy` ("id", "name") SELECT "id", "name" FROM `routines`;',
        "DROP TABLE `copy`;",
        "CREATE TABLE `copy` (`id` text);",
        "DROP TABLE `routines`;",
        "ALTER TABLE `copy` RENAME TO `routines`;",
      ),
    );

    expect(removals).toEqual([
      { table: "routines", column: "name", migration: "0086_rebuild_routines" },
    ]);
  });

  it("passes a rebuild that renames the table away and creates it again", () => {
    const removals = check(
      { routines: ["id", "name"] },
      migration(
        "0087_rebuild_routines",
        "ALTER TABLE `routines` RENAME TO `routines_old`;",
        "CREATE TABLE `routines` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL);",
        'INSERT INTO `routines` ("id", "name") SELECT "id", "name" FROM `routines_old`;',
        "DROP TABLE `routines_old`;",
      ),
    );

    expect(removals).toEqual([]);
  });
});
