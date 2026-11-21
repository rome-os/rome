import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");
const NOW = Math.floor(Date.now() / 1000);

function migrationSql(tag: string): string[] {
  return readFileSync(join(MIGRATIONS_DIR, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function tags(): string[] {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((entry) => entry.tag);
}

/** A database migrated up to, but not including, migration `tag`. */
function databaseBefore(tag: string): Database.Database {
  const all = tags();
  expect(all).toContain(tag);
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const earlier of all.slice(0, all.indexOf(tag))) {
    for (const statement of migrationSql(earlier)) sqlite.exec(statement);
  }
  return sqlite;
}

function migrate(sqlite: Database.Database, tag: string): void {
  for (const statement of migrationSql(tag)) sqlite.exec(statement);
}

/** One connection of `kind` with its grant, its channel and its account. */
function connect(sqlite: Database.Database, id: string, kind: string, accountId: string): void {
  sqlite
    .prepare("INSERT INTO connections (id, connection_kind, label, created_at) VALUES (?, ?, ?, ?)")
    .run(id, kind, kind, NOW);
  sqlite
    .prepare(
      `INSERT INTO connection_grants (custody, state, credential, platform, account_id)
       VALUES (?, 'authorized', ?, 'slack', ?)`,
    )
    .run(id, JSON.stringify({ token: `token-of-${id}` }), accountId);
  sqlite
    .prepare(
      `INSERT INTO channels (id, connection_kind, platform, connection_id, platform_account_id, created_at)
       VALUES (?, ?, 'slack', ?, ?, ?)`,
    )
    .run(`channel-${id}`, kind, id, accountId, NOW);
  sqlite
    .prepare(
      "INSERT INTO connected_accounts (platform, account_id, agent) VALUES ('slack', ?, 'main')",
    )
    .run(accountId);
}

function ids(sqlite: Database.Database, sql: string): unknown[] {
  return (sqlite.prepare(sql).all() as Record<string, unknown>[]).map(
    (row) => Object.values(row)[0],
  );
}

const SLACK_BOT = "0152_remove_slack_bot_connections";

describe("0152 removes the Slack bot's connections", () => {
  it("deletes the Slack bot's connections and grants, and keeps the Slack sign-in and Rome's Slack app", () => {
    const sqlite = databaseBefore(SLACK_BOT);
    connect(sqlite, "conn-bot", "slack_bot", "T1:B1");
    connect(sqlite, "conn-sign-in", "slack", "T1:U1");
    connect(sqlite, "conn-app", "slack_app", "T1:B2");
    sqlite
      .prepare("INSERT INTO connected_accounts_unplaced (connection_id, agent) VALUES (?, 'main')")
      .run("conn-bot");

    migrate(sqlite, SLACK_BOT);

    expect(ids(sqlite, "SELECT id FROM connections ORDER BY id")).toEqual([
      "conn-app",
      "conn-sign-in",
    ]);
    expect(ids(sqlite, "SELECT custody FROM connection_grants ORDER BY custody")).toEqual([
      "conn-app",
      "conn-sign-in",
    ]);
    expect(ids(sqlite, "SELECT connection_id FROM connected_accounts_unplaced")).toEqual([]);
    // The channels stay, let go of their connection as a disconnect leaves them.
    expect(sqlite.prepare("SELECT id, connection_id FROM channels ORDER BY id").all()).toEqual([
      { id: "channel-conn-app", connection_id: "conn-app" },
      { id: "channel-conn-bot", connection_id: null },
      { id: "channel-conn-sign-in", connection_id: "conn-sign-in" },
    ]);
    // Connected accounts, and so their agents, stay.
    expect(ids(sqlite, "SELECT account_id FROM connected_accounts ORDER BY account_id")).toEqual([
      "T1:B1",
      "T1:B2",
      "T1:U1",
    ]);
  });

  it("changes nothing on a database with no Slack bot", () => {
    const sqlite = databaseBefore(SLACK_BOT);
    connect(sqlite, "conn-app", "slack_app", "T1:B2");
    connect(sqlite, "conn-github", "github", "octocat");

    migrate(sqlite, SLACK_BOT);

    expect(ids(sqlite, "SELECT id FROM connections ORDER BY id")).toEqual([
      "conn-app",
      "conn-github",
    ]);
    expect(ids(sqlite, "SELECT custody FROM connection_grants ORDER BY custody")).toEqual([
      "conn-app",
      "conn-github",
    ]);
    expect(ids(sqlite, "SELECT connection_id FROM channels ORDER BY connection_id")).toEqual([
      "conn-app",
      "conn-github",
    ]);
  });
});

const SLACK_SIGN_IN = "0153_remove_slack_sign_in_connections";

describe("0153 removes the Slack sign-in's connections", () => {
  it("deletes the Slack sign-in's connections and grants, and keeps Rome's Slack app", () => {
    const sqlite = databaseBefore(SLACK_SIGN_IN);
    connect(sqlite, "conn-sign-in", "slack", "T1:U1");
    connect(sqlite, "conn-app", "slack_app", "T1:B2");
    sqlite
      .prepare("INSERT INTO connected_accounts_unplaced (connection_id, agent) VALUES (?, 'main')")
      .run("conn-sign-in");

    migrate(sqlite, SLACK_SIGN_IN);

    expect(ids(sqlite, "SELECT id FROM connections")).toEqual(["conn-app"]);
    expect(ids(sqlite, "SELECT custody FROM connection_grants")).toEqual(["conn-app"]);
    expect(ids(sqlite, "SELECT connection_id FROM connected_accounts_unplaced")).toEqual([]);
    // The channels stay, let go of their connection as a disconnect leaves them.
    expect(sqlite.prepare("SELECT id, connection_id FROM channels ORDER BY id").all()).toEqual([
      { id: "channel-conn-app", connection_id: "conn-app" },
      { id: "channel-conn-sign-in", connection_id: null },
    ]);
    // Connected accounts, and so their agents, stay.
    expect(ids(sqlite, "SELECT account_id FROM connected_accounts ORDER BY account_id")).toEqual([
      "T1:B2",
      "T1:U1",
    ]);
  });

  it("changes nothing on a database with no Slack sign-in", () => {
    const sqlite = databaseBefore(SLACK_SIGN_IN);
    connect(sqlite, "conn-app", "slack_app", "T1:B2");
    connect(sqlite, "conn-github", "github", "octocat");

    migrate(sqlite, SLACK_SIGN_IN);

    expect(ids(sqlite, "SELECT id FROM connections ORDER BY id")).toEqual([
      "conn-app",
      "conn-github",
    ]);
    expect(ids(sqlite, "SELECT custody FROM connection_grants ORDER BY custody")).toEqual([
      "conn-app",
      "conn-github",
    ]);
  });
});
