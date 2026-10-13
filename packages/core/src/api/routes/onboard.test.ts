import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

rs.mock("../../profile-memory.js", () => ({
  ensureProfileMemoryInitialized: rs.fn(() => mkdtempSync(join(tmpdir(), "onboard-"))),
}));

import { onboardRoutes } from "./onboard.js";
import { AGENT_PRESETS } from "../../lib/agent-presets.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { guardianAuth, persons, settings } from "../../db/schema.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

beforeEach(() => {
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(settings).run();
  testDb.db.delete(persons).run();
});

// Local-first setup is the account step alone: creating the seat also names the
// guardian from the username, gives the agent a preset identity, and marks
// onboarding complete, so the box drops straight into the welcome conversation.
describe("/api/onboard/create-account — finishes setup with defaults", () => {
  async function buildLocalApp(): Promise<Hono> {
    const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => false };
    return new Hono().route("/api", onboardRoutes(deps));
  }

  async function createAccount(app: Hono) {
    return app.request("/api/onboard/create-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "alex", password: "hunter2hunter2" }),
    });
  }

  it("names the guardian from the username, presets the agent, and marks onboarding complete", async () => {
    expect(getRomeCloudOrigin()).toBeNull();
    const app = await buildLocalApp();

    const res = await createAccount(app);

    expect(res.status).toBe(200);
    const [guardian] = testDb.db.select().from(guardianAuth).all();
    expect(guardian.userId).toBe("alex");
    expect(guardian.onboardingComplete).toBe(true);
    const [person] = testDb.db
      .select()
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"))
      .all();
    expect(person).toMatchObject({ displayName: "alex", approved: true });

    const stored = Object.fromEntries(
      testDb.db
        .select()
        .from(settings)
        .all()
        .map((row) => [row.key, row.value]),
    );
    const preset = AGENT_PRESETS.find((p) => p.name === stored.agentName);
    expect(preset).toBeDefined();
    expect(stored.agentPurpose).toBe(preset?.purpose);
    expect(stored.guardianName).toBe("alex");
  });
});
