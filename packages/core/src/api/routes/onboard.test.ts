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
import { getRomeCloudOrigin } from "../../instance/rome-cloud-origin.js";
import { guardianAuth, identities, links, persons, settings } from "../../db/schema.js";
import { accountEntry } from "../../access/application/account-entry.js";
import { listMembers, memberContext } from "../../access/application/members.js";
import { ownAccountConnected } from "../../access/application/own-account-connect.js";
import { DrizzleConnectionsRepository } from "../../connections/repository-db.js";
import { ConnectionRegistry } from "../../connections/registry.js";
import { SetupManager } from "../../connections/setup/manager.js";
import type { SetupFn } from "../../connections/setup/types.js";
import { makePasteTalk } from "../../connections/test-fixtures.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

beforeEach(() => {
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(settings).run();
  testDb.db.delete(persons).run();
  testDb.db.delete(identities).run();
});

// Local-first setup is the account step alone: creating the seat also names the
// guardian from the username, gives the agent a preset identity, and marks
// onboarding complete, so the box drops straight into the dashboard.
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
    expect(testDb.db.select().from(persons).all()).toEqual([]);

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

  it("makes the guardian with no accounts, since a local seat names none", async () => {
    await createAccount(await buildLocalApp());

    expect(await listMembers(memberContext(testDb.db))).toEqual([
      { person: expect.objectContaining({ name: "alex" }), role: "guardian", accounts: [] },
    ]);
  });
});

// A Rome set up here has no row in the earlier `persons` table, so connecting
// the guardian's own account must make it theirs through Identity alone.
describe("an own-account connect on a Rome set up through onboarding", () => {
  /** A setup signed in as the account `id`, which is also the one it reaches. */
  const signedInAs =
    (id: string): SetupFn =>
    async () => ({
      credential: { material: { token: "t" }, expiresAt: "never" },
      profile: { botId: id },
      connectedBy: { id },
    });

  it("lets a message from that account in as the guardian, writing no row to `persons`", async () => {
    const deps = { ...(await buildTestDeps(testDb.db)), isCloudAuthEnabled: async () => false };
    const app = new Hono().route("/api", onboardRoutes(deps));
    const created = await app.request("/api/onboard/create-account", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "alex", password: "hunter2hunter2" }),
    });
    expect(created.status).toBe(200);

    const registry = new ConnectionRegistry({
      repository: new DrizzleConnectionsRepository(testDb.db),
    });
    const { descriptor } = makePasteTalk();
    registry.register({ ...descriptor, auth: { ...descriptor.auth, setup: signedInAs("self-7") } });
    const manager = new SetupManager({ registry, participant: ownAccountConnected() });
    const started = await manager.start({ connectionKind: descriptor.connectionKind }, "bot");
    expect((await manager.provideInput(started.cid, {}))?.state.status).toBe("done");

    const enter = accountEntry({ db: testDb.db });
    expect(await enter({ platform: descriptor.connectionKind, id: "self-7" })).toEqual({
      kind: "entered",
      person: { kind: "guardian", userId: "alex", via: "account" },
    });
    expect(testDb.db.select().from(persons).all()).toEqual([]);
    expect(testDb.db.select().from(links).all()).toEqual([]);
  });
});
