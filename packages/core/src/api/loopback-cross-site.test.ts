/**
 * The internal listener refuses a mutation that a browser page on another
 * site sends over loopback. The in-container browser shares loopback with
 * Rome's own callers, so without the guard such a page acts as the guardian.
 */
import { afterAll, beforeEach, describe, expect, it } from "@rstest/core";
import jwt from "jsonwebtoken";
import { buildApp } from "./index.js";
import type { ApiConfig } from "./deps.js";
import { COOKIE_NAME, JWT_SECRET } from "../lib/auth.js";
import { guardianAuth, settings } from "../db/schema.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { GUARDIAN_TIMEZONE_SETTING_KEY } from "../routines/guardian-timezone.js";
import { buildTestDeps, createTestDb } from "../test/helpers.js";

const TEST_CONFIG: ApiConfig = { port: 0, host: "127.0.0.1" };
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

const testDb = createTestDb();
afterAll(() => testDb.close());

beforeEach(() => {
  testDb.db.delete(guardianAuth).run();
  testDb.db.delete(settings).run();
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId: "guardian",
      passwordHash: "unused",
      onboardingComplete: true,
      createdAt: new Date(),
    })
    .run();
});

// A cross-site "simple" request: a text/plain POST needs no CORS preflight.
async function reportTimezone(headers: Record<string, string>): Promise<Response> {
  const deps = await buildTestDeps(testDb.db);
  const { app } = buildApp(deps, TEST_CONFIG);
  return app.request(
    "http://127.0.0.1:4141/api/settings/guardian-timezone/detected",
    {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8", ...headers },
      body: JSON.stringify({ timezone: "America/New_York" }),
    },
    LOOPBACK,
  );
}

async function storedTimezone(): Promise<unknown> {
  return new SettingsRepository(testDb.db).get(GUARDIAN_TIMEZONE_SETTING_KEY);
}

describe("cross-site mutations on the loopback listener", () => {
  it("refuses a page on another site and leaves the setting unwritten", async () => {
    const res = await reportTimezone({
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(res.status).toBe(403);
    expect(await storedTimezone()).toBeNull();
  });

  it("refuses a non-loopback Origin from a client that sends no Fetch Metadata", async () => {
    const res = await reportTimezone({ origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("refuses a page on another loopback port", async () => {
    const res = await reportTimezone({
      origin: "http://127.0.0.1:3000",
      "sec-fetch-site": "same-site",
    });
    expect(res.status).toBe(403);
  });

  it("serves the dashboard on its own origin", async () => {
    const res = await reportTimezone({
      origin: "http://127.0.0.1:4141",
      "sec-fetch-site": "same-origin",
    });
    expect(res.status).toBe(200);
    expect(await storedTimezone()).toBe("America/New_York");
  });

  it("serves a caller that is not a browser", async () => {
    const res = await reportTimezone({});
    expect(res.status).toBe(200);
  });

  it("leaves proxied traffic to the edge and the route", async () => {
    const token = jwt.sign({ userId: "guardian" }, JWT_SECRET, { expiresIn: "1h" });
    const res = await reportTimezone({
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      "x-forwarded-for": "203.0.113.7",
      cookie: `${COOKIE_NAME}=${token}`,
    });
    expect(res.status).toBe(200);
  });
});
