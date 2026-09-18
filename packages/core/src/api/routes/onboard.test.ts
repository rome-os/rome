/**
 * `/api/onboard/setup` — the guardian profile step. Driven over HTTP with a
 * minted guardian session cookie. Pins the behavior that keeps the
 * "Hi <accountId-uuid>" greeting from coming back: the guardian's display name
 * is required, and a blank one is rejected BEFORE anything is persisted (so the
 * accountId can never be silently written into settings.guardianName). The
 * write itself is the shared `applyGuardianProfile`, the same function the cloud
 * sign-in callback uses, so both leave the same rows.
 */
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
import * as guardianProfile from "../../lib/guardian-profile.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { COOKIE_NAME, createSession } from "../../lib/auth.js";
import { CLOUD_GUARDIAN_PASSWORD_SENTINEL } from "../../lib/guardian-auth-state.js";
import { guardianAuth, persons, settings } from "../../db/schema.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

const ACCOUNT_ID = "d2aed3db-152a-47cc-bf96-af5f7814d2b7";

beforeEach(() => {
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(settings).run();
  testDb.db.delete(persons).run();
});

// A cloud seat: the userId is the opaque Rome Cloud accountId and there is no
// local password (the sentinel stands in for the NOT NULL column).
function insertCloudGuardian(): void {
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId: ACCOUNT_ID,
      passwordHash: CLOUD_GUARDIAN_PASSWORD_SENTINEL,
      accountId: ACCOUNT_ID,
      createdAt: new Date(),
    })
    .run();
}

async function buildApp(): Promise<{ app: Hono; cookie: string }> {
  const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => true };
  const app = new Hono();
  app.route("/api", onboardRoutes(deps));
  return { app, cookie: `${COOKIE_NAME}=${createSession(ACCOUNT_ID)}` };
}

describe("/api/onboard/setup — guardian name is required", () => {
  it("rejects a blank guardian name and persists nothing", async () => {
    insertCloudGuardian();
    const { app, cookie } = await buildApp();

    const res = await app.request("/api/onboard/setup", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ profile: { agentName: "Atlas", guardianName: "   " } }),
    });

    expect(res.status).toBe(400);
    // The reject fires before any write — no guardian person row, and the
    // accountId never lands in settings.guardianName.
    const guardianPersons = testDb.db
      .select()
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"))
      .all();
    expect(guardianPersons).toHaveLength(0);
    const [nameSetting] = testDb.db
      .select()
      .from(settings)
      .where(eq(settings.key, "guardianName"))
      .all();
    expect(nameSetting).toBeUndefined();
  });
});

describe("/api/onboard/setup — writes the profile through the shared function", () => {
  it("writes the same fields the cloud sign-in callback writes", async () => {
    insertCloudGuardian();
    const { app, cookie } = await buildApp();
    const spy = rs.spyOn(guardianProfile, "applyGuardianProfile");

    const res = await app.request("/api/onboard/setup", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        profile: {
          guardianName: "Alex Doe",
          agentName: "Atlas",
          agentPurpose: "A creature of weight.",
          guardianTimezone: "Asia/Tokyo",
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][0]).toMatchObject({ guardianName: "Alex Doe", agentName: "Atlas" });
    const [person] = testDb.db
      .select()
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"))
      .all();
    expect(person).toMatchObject({ id: "alex-doe", displayName: "Alex Doe", approved: true });
    const stored = Object.fromEntries(
      testDb.db
        .select()
        .from(settings)
        .all()
        .map((row) => [row.key, row.value]),
    );
    expect(stored).toMatchObject({
      guardianName: "Alex Doe",
      agentName: "Atlas",
      agentPurpose: "A creature of weight.",
      guardianTimezone: "Asia/Tokyo",
    });
    spy.mockRestore();
  });
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

  it("names the guardian from the username and marks onboarding complete", async () => {
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
  });

  it("gives the agent a preset name and purpose", async () => {
    const app = await buildLocalApp();

    await createAccount(app);

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
