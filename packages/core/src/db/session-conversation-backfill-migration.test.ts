import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

function runMigration(sqlite: Database.Database) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const migration = readFileSync(
    resolve(__dirname, "../../drizzle/system/0068_backfill_session_conversation_id.sql"),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) sqlite.exec(trimmed);
  }
}

describe("0068_backfill_session_conversation_id migration", () => {
  it("places each row in a conversation rome_sessions already holds", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE rome_sessions (id text PRIMARY KEY NOT NULL);
        CREATE TABLE sessions (
          id text PRIMARY KEY NOT NULL,
          channel_thread_key text,
          conversation_id text
        );
        INSERT INTO rome_sessions (id) VALUES
          ('chat'), ('fork'), ('child'), ('channel:telegram:42'), ('channel:slack:C1:T9'),
          ('channel:webchat:gone'), ('adhoc');
        INSERT INTO sessions (id, channel_thread_key, conversation_id) VALUES
          ('webchat', 'webchat:chat', NULL),
          ('model-choice', 'webchat:chat:large-model:sel', NULL),
          ('fork', 'webchat:fork', NULL),
          ('child', 'webchat:chat:subagent:1', NULL),
          ('unminted-child', 'webchat:chat:subagent:2', NULL),
          ('channel', 'telegram:42', NULL),
          ('sentinel', 'sentinel:slack:C1:T9', NULL),
          ('unknown-chat', 'webchat:gone', NULL),
          ('adhoc', 'main:adhoc', NULL),
          ('bound', 'webchat:chat', 'kept'),
          ('keyless', NULL, NULL);
      `);

      runMigration(sqlite);

      const rows = sqlite
        .prepare("SELECT id, conversation_id AS conversationId FROM sessions ORDER BY rowid")
        .all() as { id: string; conversationId: string | null }[];
      expect(Object.fromEntries(rows.map((row) => [row.id, row.conversationId]))).toEqual({
        webchat: "chat",
        "model-choice": "chat",
        fork: "fork",
        child: "child",
        "unminted-child": null,
        channel: "channel:telegram:42",
        sentinel: "channel:slack:C1:T9",
        "unknown-chat": null,
        adhoc: null,
        bound: "kept",
        keyless: null,
      });
    } finally {
      sqlite.close();
    }
  });
});
