import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

const migrationPath = (name: string) =>
  resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle/system", name);
const CHANNEL_RECORDS = readFileSync(migrationPath("0080_channel_records.sql"), "utf8");
const LINKED_AGENTS = readFileSync(migrationPath("0081_channel_linked_agents.sql"), "utf8");

function run(sqlite: Database.Database, migration: string): void {
  for (const statement of migration.split("--> statement-breakpoint")) sqlite.exec(statement);
}

describe("channel linked agents migration", () => {
  it("links main to every backed account of a linkable service, and nothing else", () => {
    const sqlite = new Database(":memory:");
    run(sqlite, CHANNEL_RECORDS);
    const insert = sqlite.prepare(
      "INSERT INTO channels (id, service, platform, connection_id, created_at) VALUES (?, ?, ?, ?, 0)",
    );
    insert.run("telegram", "telegram", "telegram", "c1");
    insert.run("telegram_user", "telegram_user", "telegram", "c2");
    insert.run("later-bot", "telegram", "telegram", "c3");
    insert.run("feishu", "feishu", "feishu", "c4");
    insert.run("discord", "discord", "discord", null);
    insert.run("agents", "agents", "agents", "c5");
    insert.run("webchat", "webchat", "webchat", "c6");

    run(sqlite, LINKED_AGENTS);

    const agents = Object.fromEntries(
      (
        sqlite.prepare("SELECT id, agent FROM channels").all() as { id: string; agent: string }[]
      ).map((row) => [row.id, row.agent]),
    );
    expect(agents).toEqual({
      telegram: "core:main",
      telegram_user: "core:main",
      "later-bot": "core:main",
      feishu: "core:main",
      discord: null,
      agents: null,
      webchat: null,
    });
  });
});
