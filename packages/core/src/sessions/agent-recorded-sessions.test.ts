import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { romeSessions } from "../db/schema.js";
import { createTestDb, type TestDb } from "../test/db.js";
import { ChatsWebChatRepository } from "../webchat/chats-webchat-repository.js";
import { AgentRecordedSessions } from "./agent-recorded-sessions.js";

describe("AgentRecordedSessions", () => {
  let testDb: TestDb;
  let sessions: AgentRecordedSessions;
  let webchat: ChatsWebChatRepository;

  beforeEach(() => {
    testDb = createTestDb();
    webchat = new ChatsWebChatRepository(testDb.db);
    sessions = new AgentRecordedSessions(webchat);
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

  it("knows no session that is not recorded", async () => {
    expect(await sessions.parentSession("missing")).toBeUndefined();
  });

  const subagent = {
    id: "sub",
    name: "core:helper: Trip",
    agentName: "core:helper",
    projectName: "trip",
    projectPath: "/p/trip",
    parentSessionId: "chat",
    parentTurnId: "turn-1",
  };

  it("adds a fresh subagent session under its parent's, and reads it back", async () => {
    add("chat", "webchat");
    await sessions.addSubagentSession(subagent);
    expect(await sessions.get("sub")).toEqual({
      type: "subagent",
      name: "core:helper: Trip",
      agentName: "core:helper",
      parentSessionId: "chat",
      projectName: "trip",
      projectPath: "/p/trip",
    });
    expect(await sessions.parentSession("sub")).toBe("chat");
    expect(await sessions.get("missing")).toBeNull();
  });

  it("adds no subagent session when its parent's is missing", async () => {
    await expect(sessions.addSubagentSession(subagent)).rejects.toThrow("was not found");
    expect(await sessions.get("sub")).toBeNull();
  });

  it("still adds the subagent session when naming its chat fails", async () => {
    add("chat", "webchat");
    rs.spyOn(webchat, "recordSessionInChat").mockRejectedValue(new Error("database is locked"));
    await sessions.addSubagentSession(subagent);
    expect(await sessions.get("sub")).toMatchObject({ type: "subagent" });
  });
});
