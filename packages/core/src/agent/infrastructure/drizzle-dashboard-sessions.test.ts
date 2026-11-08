import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { romeSessions } from "../../db/schema.js";
import { createTestDb, type TestDb } from "../../test/helpers.js";
import { DrizzleDashboardSessions } from "./drizzle-dashboard-sessions.js";

describe("DrizzleDashboardSessions", () => {
  let testDb: TestDb;
  let sessions: DrizzleDashboardSessions;

  beforeEach(() => {
    testDb = createTestDb();
    sessions = new DrizzleDashboardSessions(testDb.db);
  });

  afterEach(() => testDb.close());

  const add = (id: string, type: string, parentSessionId: string | null = null) =>
    testDb.db
      .insert(romeSessions)
      .values({
        id,
        name: id,
        type,
        parentSessionId,
        createdAt: new Date(),
        activityAt: new Date(),
      })
      .run();

  it("gives a subagent's and a fork's session their parent turn's session", async () => {
    add("chat", "webchat");
    add("sub", "subagent", "chat");
    add("fork", "fork", "chat");
    expect(await sessions.parentSession("sub")).toBe("chat");
    expect(await sessions.parentSession("fork")).toBe("chat");
  });

  it("gives any other session, and a child that names no parent, none", async () => {
    add("chat", "webchat");
    add("handoff", "webchat_handoff", "chat");
    add("orphan", "subagent");
    expect(await sessions.parentSession("chat")).toBeNull();
    expect(await sessions.parentSession("handoff")).toBeNull();
    expect(await sessions.parentSession("orphan")).toBeNull();
  });

  it("knows no session the dashboard does not have", async () => {
    expect(await sessions.parentSession("missing")).toBeUndefined();
  });
});
