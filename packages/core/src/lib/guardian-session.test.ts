/**
 * Unit spec for `resolveGuardianSessionFromMaterial` — the shared "is this
 * request the guardian?" answer behind `/auth/me`, the bootstrap phase,
 * the app-api `request.caller`, and the WebSocket upgrade path. The loopback
 * half enforces the trusted-loopback invariant (loopback peer + no
 * X-Forwarded-For), which HTTP-level tests can't reach.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { createSession } from "./auth.js";
import { resolveGuardianSessionFromMaterial } from "./guardian-session.js";
import { guardianAuth } from "../db/schema.js";
import { createTestDb } from "../test/helpers.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

beforeAll(async () => {
  await testDb.db.insert(guardianAuth).values({
    id: "auth-1",
    userId: "guardian-1",
    passwordHash: "irrelevant",
    createdAt: new Date(),
  });
});

describe("resolveGuardianSessionFromMaterial", () => {
  it("resolves a valid session token as guardian via cookie", async () => {
    const session = await resolveGuardianSessionFromMaterial(
      { sessionToken: createSession("guardian-1"), hasForwardedFor: true, peerAddress: "1.2.3.4" },
      testDb.db,
    );
    expect(session).toEqual({ userId: "guardian-1", via: "cookie" });
  });

  it("resolves a cookie-less loopback peer without XFF as guardian via loopback", async () => {
    for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const session = await resolveGuardianSessionFromMaterial(
        { sessionToken: null, hasForwardedFor: false, peerAddress: peer },
        testDb.db,
      );
      expect(session).toEqual({ userId: "guardian-1", via: "loopback" });
    }
  });

  it("demotes a loopback peer that carries X-Forwarded-For (proxied traffic)", async () => {
    const session = await resolveGuardianSessionFromMaterial(
      { sessionToken: null, hasForwardedFor: true, peerAddress: "127.0.0.1" },
      testDb.db,
    );
    expect(session).toBeNull();
  });

  it("rejects a non-loopback peer without a cookie", async () => {
    const session = await resolveGuardianSessionFromMaterial(
      { sessionToken: null, hasForwardedFor: false, peerAddress: "10.0.0.5" },
      testDb.db,
    );
    expect(session).toBeNull();
  });

  it("fails closed when the peer address is unknown", async () => {
    const session = await resolveGuardianSessionFromMaterial(
      { sessionToken: null, hasForwardedFor: false, peerAddress: undefined },
      testDb.db,
    );
    expect(session).toBeNull();
  });

  it("ignores a garbage session token (falls through to loopback rules)", async () => {
    const session = await resolveGuardianSessionFromMaterial(
      { sessionToken: "not-a-jwt", hasForwardedFor: true, peerAddress: "1.2.3.4" },
      testDb.db,
    );
    expect(session).toBeNull();
  });
});
