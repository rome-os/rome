/**
 * `/api/auth/me` — the dashboard's "who am I" probe (the shell's profile menu
 * reads it). Returns one of the two authenticated identities as a
 * `DashboardIdentity`:
 *
 *   - guardian: valid `rome_session` cookie or trusted in-container loopback.
 *     Password login and cloud sign-in mint identical tokens, so both surface
 *     the same way. `displayName` is the onboarding `guardianName` setting.
 *   - visitor: valid `rome_visitor` cookie whose email is on the dashboard
 *     allow-list. A visitor cookie without dashboard access is anonymous here.
 *
 * Anything else is `anonymous` (200, not 401 — the route is a public probe).
 */
import { afterAll, beforeEach, describe, expect, it } from "@rstest/core";
import jwt from "jsonwebtoken";
import { buildApp } from "../index.js";
import { COOKIE_NAME, JWT_SECRET, VISITOR_COOKIE_NAME } from "../../lib/auth.js";
import type { ApiConfig } from "../deps.js";
import { guardianAuth, settings } from "../../db/schema.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

const TEST_CONFIG: ApiConfig = { port: 0, host: "127.0.0.1" };

const testDb = createTestDb();
afterAll(() => testDb.close());

beforeEach(() => {
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(settings).run();
});

function insertGuardian(userId = "guardian", avatarUrl: string | null = null): void {
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId,
      passwordHash: "unused",
      avatarUrl,
      onboardingComplete: true,
      createdAt: new Date(),
    })
    .run();
}

function insertGuardianName(name: string): void {
  testDb.db
    .insert(settings)
    .values({ key: "guardianName", value: name, updatedAt: new Date() })
    .run();
}

function guardianCookie(userId = "u1"): string {
  const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: "1h" });
  return `${COOKIE_NAME}=${token}`;
}

function visitorCookie(
  accountId = "acc-1",
  email = "friend@example.com",
  avatarUrl: string | null = null,
): string {
  const token = jwt.sign({ kind: "visitor", accountId, email, avatarUrl }, JWT_SECRET, {
    expiresIn: "1h",
  });
  return `${VISITOR_COOKIE_NAME}=${token}`;
}

async function meRequest(options: {
  cookies?: string[];
  allowedEmails?: string[];
  remoteAddress?: string;
  forwardedFor?: string;
}): Promise<unknown> {
  const deps = await buildTestDeps(testDb.db);
  if (options.allowedEmails) {
    deps.dashboardAccessState.setCloudEmailAccess(options.allowedEmails);
  }
  const { app } = buildApp(deps, TEST_CONFIG);
  const headers: Record<string, string> = {};
  if (options.cookies?.length) headers.cookie = options.cookies.join("; ");
  if (options.forwardedFor) headers["X-Forwarded-For"] = options.forwardedFor;
  const env =
    options.remoteAddress === undefined
      ? undefined
      : { incoming: { socket: { remoteAddress: options.remoteAddress } } };
  const res = await app.request("/api/auth/me", { headers }, env);
  expect(res.status).toBe(200);
  return res.json();
}

describe("/api/auth/me", () => {
  it("reports a guardian cookie session with the guardianName setting", async () => {
    insertGuardian();
    insertGuardianName("Evan");
    const body = await meRequest({
      cookies: [guardianCookie("u1")],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(body).toEqual({
      kind: "guardian",
      userId: "u1",
      displayName: "Evan",
      avatarUrl: null,
    });
  });

  it("reports null displayName when guardianName was never set", async () => {
    insertGuardian();
    const body = await meRequest({
      cookies: [guardianCookie("u1")],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(body).toEqual({ kind: "guardian", userId: "u1", displayName: null, avatarUrl: null });
  });

  it("reports a cookieless loopback caller as the guardian", async () => {
    insertGuardian("guardian");
    insertGuardianName("Evan");
    const body = await meRequest({ remoteAddress: "127.0.0.1" });
    expect(body).toEqual({
      kind: "guardian",
      userId: "guardian",
      displayName: "Evan",
      avatarUrl: null,
    });
  });

  it("reports an allow-listed visitor cookie as a visitor", async () => {
    const body = await meRequest({
      cookies: [visitorCookie("acc-1", "friend@example.com")],
      allowedEmails: ["friend@example.com"],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(body).toEqual({
      kind: "visitor",
      accountId: "acc-1",
      email: "friend@example.com",
      avatarUrl: null,
    });
  });

  it("treats a visitor without dashboard access as anonymous", async () => {
    const body = await meRequest({
      cookies: [visitorCookie("acc-1", "stranger@example.com")],
      allowedEmails: ["friend@example.com"],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(body).toEqual({ kind: "anonymous" });
  });

  it("prefers the guardian identity when both cookies are present", async () => {
    insertGuardian();
    insertGuardianName("Evan");
    const body = await meRequest({
      cookies: [guardianCookie("u1"), visitorCookie("acc-1", "friend@example.com")],
      allowedEmails: ["friend@example.com"],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(body).toEqual({
      kind: "guardian",
      userId: "u1",
      displayName: "Evan",
      avatarUrl: null,
    });
  });

  it("reports an unauthenticated proxied caller as anonymous", async () => {
    insertGuardian();
    const body = await meRequest({ forwardedFor: "203.0.113.7", remoteAddress: "127.0.0.1" });
    expect(body).toEqual({ kind: "anonymous" });
  });

  it("reports the locally cached avatar for guardian and visitor identities", async () => {
    insertGuardian("guardian", "https://example.com/guardian.png");
    insertGuardianName("Evan");
    const guardian = await meRequest({
      cookies: [guardianCookie("u1")],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(guardian).toMatchObject({ avatarUrl: "https://example.com/guardian.png" });

    const visitor = await meRequest({
      cookies: [visitorCookie("acc-1", "friend@example.com", "https://example.com/visitor.png")],
      allowedEmails: ["friend@example.com"],
      forwardedFor: "203.0.113.7",
      remoteAddress: "127.0.0.1",
    });
    expect(visitor).toMatchObject({ avatarUrl: "https://example.com/visitor.png" });
  });
});
