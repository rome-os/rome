import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { SessionManager } from "./session-manager.js";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { SessionsRepository } from "../db/repositories/sessions.js";
import { sessions } from "../db/schema.js";
import {
  claimLegacyArtifactName,
  createEmptyLegacyArtifactBindings,
  formatArtifactId,
} from "../apps/artifact-id.js";

describe("SessionManager", () => {
  let testDb: TestDb;
  let repo: SessionsRepository;
  let manager: SessionManager;

  beforeEach(() => {
    testDb = createTestDb();
    repo = new SessionsRepository(testDb.db);
    manager = new SessionManager(repo);
  });

  afterEach(() => testDb.close());

  it("reuses an active session regardless of idle time", async () => {
    const id = await repo.create({
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
      status: "active",
    });
    await testDb.db
      .update(sessions)
      .set({ lastActiveAt: new Date("2020-01-01T00:00:00Z") })
      .where(eq(sessions.id, id));

    await expect(manager.findReusableSession("telegram:thread-1", "main")).resolves.toMatchObject({
      id,
    });
  });

  it("does not reuse a provider session under a different calculated routing key", async () => {
    await repo.create({
      id: "runtime-1",
      agentName: "main",
      channelThreadKey: "telegram:old-routing-key",
    });

    await expect(
      manager.findReusableSession("telegram:new-routing-key", "main"),
    ).resolves.toBeUndefined();
  });

  it("does not reuse completed sessions", async () => {
    const id = await repo.create({
      agentName: "main",
      channelThreadKey: "telegram:thread-1",
    });
    await repo.complete(id);
    await expect(manager.findReusableSession("telegram:thread-1", "main")).resolves.toBeUndefined();
  });

  it("keeps agent bindings isolated", async () => {
    await repo.create({
      id: "main-runtime",
      agentName: "main",
      channelThreadKey: "discord:thread-1",
    });
    await expect(
      manager.findReusableSession("discord:thread-1", "other-agent"),
    ).resolves.toBeUndefined();
  });

  it("reuses a legacy bare-name row for the canonical agent without migrating it", async () => {
    const bindings = createEmptyLegacyArtifactBindings();
    claimLegacyArtifactName(
      bindings,
      "agent",
      "reviewer",
      formatArtifactId("code-review", "reviewer"),
    );
    manager = new SessionManager(repo, { legacyBindings: bindings });
    await repo.create({
      id: "legacy-runtime",
      agentName: "reviewer",
      channelThreadKey: "webchat:review",
    });

    await expect(
      manager.findReusableSession("webchat:review", "code-review:reviewer"),
    ).resolves.toMatchObject({ id: "legacy-runtime" });
    const row = await repo.findById("legacy-runtime");
    expect(row?.agentName).toBe("reviewer");
  });
});
