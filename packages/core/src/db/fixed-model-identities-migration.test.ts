import { readFileSync } from "node:fs";
import { describe, expect, it } from "@rstest/core";
import Database from "better-sqlite3";
import { LEGACY_MODEL_SELECTIONS } from "@rome/api-types/models";

const migration = readFileSync(
  new URL("../../drizzle/system/0154_fixed_model_identities.sql", import.meta.url),
  "utf8",
);

describe("fixed model identity migration", () => {
  it("freezes every known choice, is idempotent, and leaves unknown choices and history untouched", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE rome_sessions (id text, large_model_selection text, large_model_selection_by text); CREATE TABLE settings (key text, value text); CREATE TABLE sessions (model text, provider text)",
      );
      const insert = db.prepare("INSERT INTO rome_sessions VALUES (?, ?, ?)");
      for (const [old] of Object.entries(LEGACY_MODEL_SELECTIONS)) insert.run(old, old, "owner");
      for (const value of ["unknown-model", "anthropic/future-model[1m]", "auto", null])
        insert.run(String(value), value, "kept");
      db.prepare("INSERT INTO sessions VALUES (?, ?)").run("claude-opus-4-8[1m]", "anthropic");
      db.prepare("INSERT INTO settings VALUES (?, ?)").run(
        "webchatLargeModel",
        JSON.stringify("claude-opus"),
      );
      db.prepare("INSERT INTO settings VALUES (?, ?)").run(
        "unrelated",
        JSON.stringify("claude-opus"),
      );
      db.exec(migration);
      const snapshot = () => ({
        chats: db.prepare("SELECT * FROM rome_sessions").all(),
        settings: db.prepare("SELECT * FROM settings").all(),
        sessions: db.prepare("SELECT * FROM sessions").all(),
      });
      const once = snapshot();
      db.exec(migration);
      expect(snapshot()).toEqual(once);
      for (const [old, fixed] of Object.entries(LEGACY_MODEL_SELECTIONS)) {
        expect(
          db
            .prepare(
              "SELECT large_model_selection, large_model_selection_by FROM rome_sessions WHERE id = ?",
            )
            .get(old),
        ).toEqual({ large_model_selection: fixed, large_model_selection_by: "owner" });
      }
      expect(
        db.prepare("SELECT value FROM settings WHERE key = 'webchatLargeModel'").get(),
      ).toEqual({ value: JSON.stringify("anthropic/claude-opus-4-8[1m]") });
      expect(db.prepare("SELECT value FROM settings WHERE key = 'unrelated'").get()).toEqual({
        value: JSON.stringify("claude-opus"),
      });
      expect(db.prepare("SELECT * FROM sessions").get()).toEqual({
        model: "claude-opus-4-8[1m]",
        provider: "anthropic",
      });
      expect(
        db
          .prepare("SELECT large_model_selection FROM rome_sessions WHERE id = 'unknown-model'")
          .get(),
      ).toEqual({ large_model_selection: "unknown-model" });
    } finally {
      db.close();
    }
  });
  it.each(
    Object.entries(LEGACY_MODEL_SELECTIONS),
  )("freezes default preference %s at %s", (old, fixed) => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE rome_sessions (large_model_selection text); CREATE TABLE settings (key text, value text)",
      );
      db.prepare("INSERT INTO settings VALUES ('webchatLargeModel', ?)").run(JSON.stringify(old));
      db.exec(migration);
      expect(db.prepare("SELECT value FROM settings").get()).toEqual({
        value: JSON.stringify(fixed),
      });
    } finally {
      db.close();
    }
  });
  it.each([
    '"unknown"',
    '"auto"',
    '"anthropic/claude-opus-4-8[1m]"',
    "null",
    '{"custom":true}',
    "malformed-json",
  ])("does not rewrite unrelated preference %s", (value) => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE rome_sessions (large_model_selection text); CREATE TABLE settings (key text, value text)",
      );
      db.prepare("INSERT INTO settings VALUES ('webchatLargeModel', ?)").run(value);
      db.exec(migration);
      expect(db.prepare("SELECT value FROM settings").get()).toEqual({ value });
    } finally {
      db.close();
    }
  });
});
