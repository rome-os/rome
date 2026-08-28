import { afterEach, describe, expect, it } from "@rstest/core";
import { SessionManager } from "./session-manager.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { SessionsRepository } from "../db/repositories/sessions.js";

describe("Session continuity (integration)", () => {
  let testDb: TestDb;

  afterEach(() => testDb?.close());

  it("survives a manager restart and resumes the same provider mapping", async () => {
    testDb = createTestDb();
    const repo = new SessionsRepository(testDb.db);
    const firstManager = new SessionManager(repo);
    await firstManager.createSession({
      id: "runtime-session",
      agentName: "main",
      channelThreadKey: "telegram:chat-1",
      createdAt: new Date(),
      lastActiveAt: new Date(),
      status: "active",
    });
    await firstManager.setProviderInfo("runtime-session", "openai", "provider-thread", "gpt-5");

    const restartedManager = new SessionManager(new SessionsRepository(testDb.db));
    await expect(restartedManager.findReusableSession("telegram:chat-1", "main")).resolves.toEqual({
      id: "runtime-session",
      provider: "openai",
      providerThreadId: "provider-thread",
      model: "gpt-5",
      createdAt: expect.any(Date),
      lastActiveAt: expect.any(Date),
    });
  });
});
