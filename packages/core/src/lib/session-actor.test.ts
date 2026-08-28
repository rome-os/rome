import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { createTestDb, type TestDb } from "../test/helpers.js";
import { guardianAuth } from "../db/schema.js";
import { createSession, createVisitorSession } from "./auth.js";
import {
  currentSessionActor,
  resolveSessionActorFromMaterial,
  runWithSessionActor,
  withoutSessionActor,
  type SessionActor,
  type SessionActorMaterial,
} from "./session-actor.js";

const SEAT_USER_ID = "seat-user-1";
const SEAT_ACCOUNT_ID = "acct-42";
const SEAT_EMAIL = "guardian@example.com";

function material(overrides: Partial<SessionActorMaterial> = {}): SessionActorMaterial {
  return {
    sessionToken: null,
    visitorToken: null,
    hasForwardedFor: false,
    peerAddress: undefined,
    ...overrides,
  };
}

describe("resolveSessionActorFromMaterial", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  async function seedSeat(fields: Partial<typeof guardianAuth.$inferInsert> = {}) {
    await testDb.db.insert(guardianAuth).values({
      id: "seat-row",
      userId: SEAT_USER_ID,
      passwordHash: "hash",
      accountId: SEAT_ACCOUNT_ID,
      email: SEAT_EMAIL,
      createdAt: new Date(),
      ...fields,
    });
  }

  it("resolves a guardian cookie session enriched from the seat row", async () => {
    await seedSeat();
    const actor = await resolveSessionActorFromMaterial(
      material({ sessionToken: createSession(SEAT_USER_ID) }),
      testDb.db,
    );
    expect(actor).toEqual({
      kind: "guardian",
      userId: SEAT_USER_ID,
      accountId: SEAT_ACCOUNT_ID,
      email: SEAT_EMAIL,
      via: "cookie",
    });
  });

  it("normalizes a cloud-minted JWT subject (accountId) to the canonical seat userId", async () => {
    await seedSeat();
    // Cloud login mints the session with the Rome Cloud accountId as the subject.
    const actor = await resolveSessionActorFromMaterial(
      material({ sessionToken: createSession(SEAT_ACCOUNT_ID) }),
      testDb.db,
    );
    expect(actor).toMatchObject({ kind: "guardian", userId: SEAT_USER_ID });
  });

  it("falls back to the JWT subject when no seat row exists", async () => {
    const actor = await resolveSessionActorFromMaterial(
      material({ sessionToken: createSession("jwt-only-user") }),
      testDb.db,
    );
    expect(actor).toEqual({ kind: "guardian", userId: "jwt-only-user", via: "cookie" });
  });

  it("omits accountId/email for a local-fallback seat", async () => {
    await seedSeat({ accountId: null, email: null });
    const actor = await resolveSessionActorFromMaterial(
      material({ sessionToken: createSession(SEAT_USER_ID) }),
      testDb.db,
    );
    expect(actor).toEqual({ kind: "guardian", userId: SEAT_USER_ID, via: "cookie" });
  });

  it("resolves a trusted loopback caller as the guardian seat", async () => {
    await seedSeat();
    const actor = await resolveSessionActorFromMaterial(
      material({ peerAddress: "127.0.0.1" }),
      testDb.db,
    );
    expect(actor).toMatchObject({ kind: "guardian", userId: SEAT_USER_ID, via: "loopback" });
  });

  it("does not treat a forwarded loopback peer as the guardian", async () => {
    await seedSeat();
    const actor = await resolveSessionActorFromMaterial(
      material({ peerAddress: "127.0.0.1", hasForwardedFor: true }),
      testDb.db,
    );
    expect(actor).toEqual({ kind: "anonymous" });
  });

  it("resolves a visitor cookie session", async () => {
    const actor = await resolveSessionActorFromMaterial(
      material({ visitorToken: createVisitorSession("acct-7", "friend@example.com") }),
      testDb.db,
    );
    expect(actor).toEqual({ kind: "visitor", accountId: "acct-7", email: "friend@example.com" });
  });

  it("prefers the guardian over a coexisting visitor session", async () => {
    await seedSeat();
    const actor = await resolveSessionActorFromMaterial(
      material({
        sessionToken: createSession(SEAT_USER_ID),
        visitorToken: createVisitorSession("acct-7", "friend@example.com"),
      }),
      testDb.db,
    );
    expect(actor).toMatchObject({ kind: "guardian" });
  });

  it("resolves a sessionless request as anonymous", async () => {
    const actor = await resolveSessionActorFromMaterial(material(), testDb.db);
    expect(actor).toEqual({ kind: "anonymous" });
  });
});

describe("sessionActorMiddleware", () => {
  let testDb: TestDb;

  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  async function requestActor(headers: Record<string, string>): Promise<unknown> {
    const { Hono } = await import("hono");
    const { sessionActorMiddleware } = await import("./session-actor.js");
    const app = new Hono();
    app.use("*", sessionActorMiddleware(testDb.db));
    app.get("/probe", async (c) => c.json({ actor: (await currentSessionActor()) ?? null }));
    const res = await app.request("/probe", { headers });
    return ((await res.json()) as { actor: unknown }).actor;
  }

  it("exposes the guardian actor to downstream handlers", async () => {
    await testDb.db.insert(guardianAuth).values({
      id: "seat-row",
      userId: SEAT_USER_ID,
      passwordHash: "hash",
      accountId: SEAT_ACCOUNT_ID,
      email: SEAT_EMAIL,
      createdAt: new Date(),
    });
    const actor = await requestActor({ cookie: `rome_session=${createSession(SEAT_USER_ID)}` });
    expect(actor).toEqual({
      kind: "guardian",
      userId: SEAT_USER_ID,
      accountId: SEAT_ACCOUNT_ID,
      email: SEAT_EMAIL,
      via: "cookie",
    });
  });

  it("exposes the visitor actor to downstream handlers", async () => {
    const actor = await requestActor({
      cookie: `rome_visitor=${createVisitorSession("acct-7", "friend@example.com")}`,
    });
    expect(actor).toEqual({ kind: "visitor", accountId: "acct-7", email: "friend@example.com" });
  });

  it("exposes anonymous for a sessionless request", async () => {
    // No conninfo in the test env, so loopback resolution fails closed.
    const actor = await requestActor({});
    expect(actor).toEqual({ kind: "anonymous" });
  });
});

describe("session actor ambient context", () => {
  it("is undefined outside any scope", async () => {
    expect(await currentSessionActor()).toBeUndefined();
  });

  it("exposes an already-resolved actor", async () => {
    const actor: SessionActor = { kind: "anonymous" };
    const seen = await runWithSessionActor(actor, () => currentSessionActor());
    expect(seen).toBe(actor);
  });

  it("resolves a lazy source once and memoizes it", async () => {
    const actor: SessionActor = { kind: "visitor", accountId: "a", email: "e@example.com" };
    const source = rs.fn(async () => actor);
    await runWithSessionActor(source, async () => {
      expect(await currentSessionActor()).toBe(actor);
      expect(await currentSessionActor()).toBe(actor);
    });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("fails open when the lazy source throws", async () => {
    const seen = await runWithSessionActor(
      async () => {
        throw new Error("db down");
      },
      () => currentSessionActor(),
    );
    expect(seen).toBeUndefined();
  });

  it("does not leak across sibling scopes", async () => {
    const a: SessionActor = { kind: "anonymous" };
    await runWithSessionActor(a, async () => {
      expect(await currentSessionActor()).toBe(a);
    });
    expect(await currentSessionActor()).toBeUndefined();
  });

  // A timer created inside a scope inherits the actor at its creation point —
  // the leak withoutSessionActor exists to prevent for autonomous resources.
  it("timers created inside a scope inherit the ambient actor", async () => {
    const actor: SessionActor = { kind: "anonymous" };
    const seen = await runWithSessionActor(
      actor,
      () =>
        new Promise<SessionActor | undefined>((resolve) => {
          setTimeout(() => void currentSessionActor().then(resolve), 0);
        }),
    );
    expect(seen).toEqual(actor);
  });

  it("timers created inside withoutSessionActor resolve no ambient actor", async () => {
    const actor: SessionActor = { kind: "anonymous" };
    const seen = await runWithSessionActor(actor, () =>
      withoutSessionActor(
        () =>
          new Promise<SessionActor | undefined>((resolve) => {
            setTimeout(() => void currentSessionActor().then(resolve), 0);
          }),
      ),
    );
    expect(seen).toBeUndefined();
  });
});
