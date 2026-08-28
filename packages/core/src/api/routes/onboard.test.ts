/**
 * `/api/onboard/setup` — the guardian profile step. Driven over HTTP with a
 * minted guardian session cookie. Pins the behavior that keeps the
 * "Hi <accountId-uuid>" greeting from coming back: the guardian's display name
 * is required, and a blank one is rejected BEFORE anything is persisted (so the
 * accountId can never be silently written into settings.guardianName).
 */
import { afterAll, beforeEach, describe, expect, it } from "@rstest/core";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { onboardRoutes } from "./onboard.js";
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
