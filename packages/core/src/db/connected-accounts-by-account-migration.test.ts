import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const BY_ACCOUNT = readFileSync(migrationPath("0111_connected_accounts_by_account.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("the connected accounts by account migration", () => {
  it("keys each connected account by the account its connection reaches, keeping its agent", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE connection_grants (
        custody text PRIMARY KEY NOT NULL, state text NOT NULL, platform text, account_id text
      );
      CREATE TABLE channels (
        id text PRIMARY KEY NOT NULL, platform text NOT NULL, connection_id text,
        platform_account_id text
      );
      CREATE TABLE connected_accounts (connection_id text PRIMARY KEY NOT NULL, agent text);
      INSERT INTO connection_grants (custody, state, platform, account_id) VALUES
        ('c-old', 'unauthorized', NULL, NULL),
        ('c-feishu', 'authorized', 'feishu', 'app-1'),
        ('c-broken', 'degraded', 'telegram', 'bot-1'),
        ('c-revoked', 'unauthorized', NULL, NULL),
        ('c-new', 'unauthorized', NULL, NULL);
      INSERT INTO channels (id, platform, connection_id, platform_account_id) VALUES
        -- An older, revoked connection whose channel record names the account
        -- a live grant reaches: the live grant's agent wins.
        ('feishu-old', 'feishu', 'c-old', 'app-1'),
        -- The grant's own account wins over a channel record that disagrees.
        ('feishu', 'feishu', 'c-feishu', 'stale-app'),
        -- A revoked grant names no account, so its channel record does.
        ('discord', 'discord', 'c-revoked', 'bot-9'),
        -- Knows no account yet.
        ('telegram_user', 'telegram', 'c-new', NULL);
      INSERT INTO connected_accounts (connection_id, agent) VALUES
        ('c-old', 'old:agent'),
        ('c-feishu', 'sales:agent'),
        ('c-broken', 'core:main'),
        ('c-revoked', 'support:agent'),
        ('c-new', 'sales:agent'),
        ('c-email', NULL);
    `);

    run(sqlite, BY_ACCOUNT);

    expect(
      sqlite
        .prepare("SELECT platform, account_id, agent FROM connected_accounts ORDER BY 1, 2")
        .all(),
    ).toEqual([
      { platform: "discord", account_id: "bot-9", agent: "support:agent" },
      { platform: "feishu", account_id: "app-1", agent: "sales:agent" },
      { platform: "telegram", account_id: "bot-1", agent: "core:main" },
    ]);
    // A link with no account to key it on waits for the boot pass, and one with
    // no agent has nothing to keep.
    expect(
      sqlite.prepare("SELECT connection_id, agent FROM connected_accounts_unplaced").all(),
    ).toEqual([{ connection_id: "c-new", agent: "sales:agent" }]);
  });
});
