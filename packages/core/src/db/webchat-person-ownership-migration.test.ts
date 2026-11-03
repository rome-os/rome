import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "@rstest/core";

describe("0077_webchat_person_ownership migration", () => {
  it("preserves existing sessions and inputs with NULL attribution and indexes owners", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE rome_sessions (id text PRIMARY KEY NOT NULL);
        CREATE TABLE rome_agent_messages (id text PRIMARY KEY NOT NULL, content text NOT NULL);
        INSERT INTO rome_sessions (id) VALUES ('legacy');
        INSERT INTO rome_agent_messages (id, content) VALUES ('input', '[]');
      `);
      const migration = readFileSync(
        fileURLToPath(
          new URL("../../drizzle/system/0077_webchat_person_ownership.sql", import.meta.url),
        ),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) sqlite.exec(statement);
      }
      expect(sqlite.prepare("SELECT id, owner_key FROM rome_sessions").all()).toEqual([
        { id: "legacy", owner_key: null },
      ]);
      expect(sqlite.prepare("SELECT id, content, actor FROM rome_agent_messages").all()).toEqual([
        { id: "input", content: "[]", actor: null },
      ]);
      expect(sqlite.prepare("PRAGMA index_info('idx_rome_sessions_owner_key')").all()).toEqual([
        { seqno: 0, cid: 1, name: "owner_key" },
      ]);
    } finally {
      sqlite.close();
    }
  });
});
