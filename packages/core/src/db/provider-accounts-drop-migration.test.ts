import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system");

/**
 * The migration that drops `provider_accounts`, resolved by searching the
 * journal rather than by filename, so the test fails if nothing runs it.
 */
function dropMigration(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
    entries: { tag: string }[];
  };
  const matches = journal.entries
    .map((entry) => readFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), "utf8"))
    .filter((sql) => sql.includes("DROP TABLE `provider_accounts`"));

  expect(matches, "exactly one migration should drop provider_accounts").toHaveLength(1);
  return matches[0];
}

function applyMigration(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

function databaseWithLegacyRows(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE provider_accounts (
      id text PRIMARY KEY NOT NULL,
      provider text NOT NULL,
      token_ciphertext text NOT NULL
    );
    CREATE TABLE settings (
      key text PRIMARY KEY NOT NULL,
      value text NOT NULL,
      updated_at integer NOT NULL
    );
  `);
  sqlite
    .prepare("INSERT INTO provider_accounts (id, provider, token_ciphertext) VALUES (?, ?, ?)")
    .run("gh", "github", '{"accessToken":"gho_plain"}');

  const setting = sqlite.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)");
  setting.run("telegram", JSON.stringify({ botToken: "123:abc", botUsername: "rome_bot" }));
  setting.run("discord", JSON.stringify({ botToken: "discord-token" }));
  setting.run("wechat", JSON.stringify({ token: "wechat-token", accountId: "a" }));
  setting.run("feishu", JSON.stringify({ appId: "cli_1", appSecret: "secret" }));
  setting.run("whatsapp", JSON.stringify({ authStatePath: "/data/wa" }));
  setting.run("telegram_user", JSON.stringify({ apiHash: "hash", sessionString: "sess" }));
  setting.run(
    "email",
    JSON.stringify({
      enabled: true,
      guardianEmail: "g@example.com",
      address: "rome@mail.romeos.cc",
      inboundSecret: "inbound-secret",
    }),
  );
  setting.run("guardianName", JSON.stringify("Ada"));
  return sqlite;
}

function settingsRows(sqlite: Database.Database): Record<string, unknown> {
  const rows = sqlite.prepare("SELECT key, value FROM settings ORDER BY key").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.key, JSON.parse(row.value)]));
}

describe("provider_accounts drop migration", () => {
  it("drops the table, deletes the unread channel rows, and strips email credentials", () => {
    const sqlite = databaseWithLegacyRows();
    try {
      applyMigration(sqlite, dropMigration());

      const table = sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_accounts'",
        )
        .get();
      expect(table).toBeUndefined();
      expect(settingsRows(sqlite)).toEqual({
        email: { enabled: true, guardianEmail: "g@example.com" },
        guardianName: "Ada",
      });
    } finally {
      sqlite.close();
    }
  });
});
