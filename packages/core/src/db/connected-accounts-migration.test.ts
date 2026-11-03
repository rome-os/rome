import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const CONNECTED_ACCOUNTS = readFileSync(migrationPath("0094_connected_accounts.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("the connected accounts migration", () => {
  it("gives each connection that backs a channel a connected account with the channel's agent", () => {
    const sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    sqlite.exec(`
      CREATE TABLE connections (
        id text PRIMARY KEY NOT NULL, connection_kind text NOT NULL, label text NOT NULL,
        created_at integer NOT NULL
      );
      CREATE TABLE channels (
        id text PRIMARY KEY NOT NULL, connection_kind text NOT NULL, platform text NOT NULL,
        connection_id text, platform_account_id text, created_at integer NOT NULL, agent text
      );
      CREATE TABLE connection_grants (
        custody text PRIMARY KEY NOT NULL, state text NOT NULL, platform text, account_id text
      );
      INSERT INTO connections (id, connection_kind, label, created_at) VALUES
        ('c-feishu', 'feishu', 'Sales', 1),
        ('c-moved', 'telegram', 'Bot', 1),
        ('c-new', 'telegram_user', 'Me', 1),
        ('c-email', 'email', 'Mail', 1),
        ('c-github', 'github', 'GitHub', 1);
      INSERT INTO connection_grants (custody, state, platform, account_id) VALUES
        ('c-feishu', 'authorized', 'feishu', 'app-1'),
        ('c-moved', 'degraded', 'telegram', 'bot-1'),
        ('c-new', 'unauthorized', NULL, NULL),
        ('c-email', 'authorized', 'email', 'a@x.test'),
        ('c-given-up', 'unauthorized', 'discord', 'bot-9'),
        ('c-github', 'authorized', NULL, NULL);
      INSERT INTO channels
        (id, connection_kind, platform, connection_id, platform_account_id, created_at, agent)
      VALUES
        -- Found by the grant that reaches its account.
        ('feishu', 'feishu', 'feishu', 'c-feishu', 'app-1', 1, 'sales:agent'),
        -- Its stored connection is stale: the grant that reaches the account wins.
        ('tg-1', 'telegram', 'telegram', 'c-stale', 'bot-1', 1, 'core:main'),
        -- Knows no account yet, so the connection it was claimed for.
        ('telegram_user', 'telegram_user', 'telegram', 'c-new', NULL, 1, NULL),
        -- Takes no agent, and still gets a connected account.
        ('email', 'email', 'email', 'c-email', 'a@x.test', 1, NULL),
        -- No live grant reaches it, and no connection backs it.
        ('discord', 'discord', 'discord', NULL, 'bot-9', 1, 'support:agent'),
        -- Released, and its connection is gone.
        ('old', 'telegram', 'telegram', 'c-gone', NULL, 1, 'sales:agent');
    `);

    run(sqlite, CONNECTED_ACCOUNTS);

    expect(
      sqlite.prepare("SELECT connection_id, agent FROM connected_accounts ORDER BY 1").all(),
    ).toEqual([
      { connection_id: "c-email", agent: null },
      { connection_id: "c-feishu", agent: "sales:agent" },
      { connection_id: "c-moved", agent: "core:main" },
      { connection_id: "c-new", agent: null },
    ]);

    sqlite.exec("DELETE FROM connections WHERE id = 'c-feishu'");
    expect(
      sqlite
        .prepare("SELECT connection_id FROM connected_accounts WHERE connection_id = 'c-feishu'")
        .all(),
    ).toEqual([]);
  });
});
