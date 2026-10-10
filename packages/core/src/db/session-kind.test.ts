import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { and, desc, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { romeSessions } from "./schema.js";
import { isWebchatChat } from "./session-kind.js";

describe("isWebchatChat", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  function plan(query: { toSQL(): { sql: string; params: unknown[] } }): string {
    const { sql, params } = query.toSQL();
    const sqlite = (
      testDb.db as unknown as {
        $client: {
          prepare(sql: string): { all(...values: unknown[]): Array<{ detail: string }> };
        };
      }
    ).$client;
    return sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...params)
      .map((row) => row.detail)
      .join("\n");
  }

  // The sidebar reads one page of chats newest first. A plan that sorts would
  // read every chat and every channel conversation to serve each page.
  it("pages the sidebar off the chat index without sorting", () => {
    const details = plan(
      testDb.db
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(isWebchatChat)
        .orderBy(desc(romeSessions.activityAt), desc(romeSessions.createdAt), desc(romeSessions.id))
        .limit(51),
    );

    expect(details).toContain("idx_rome_sessions_chat_activity");
    expect(details).not.toContain("TEMP B-TREE");
  });

  it("pages a project's chats off the project chat index without sorting", () => {
    const details = plan(
      testDb.db
        .select({ id: romeSessions.id })
        .from(romeSessions)
        .where(and(eq(romeSessions.projectPath, "/work/rome"), isWebchatChat))
        .orderBy(desc(romeSessions.activityAt), desc(romeSessions.createdAt), desc(romeSessions.id))
        .limit(51),
    );

    expect(details).toContain("idx_rome_sessions_chat_project_activity");
    expect(details).not.toContain("TEMP B-TREE");
  });
});
