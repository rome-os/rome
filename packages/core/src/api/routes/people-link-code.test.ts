import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import type { LinkCodeResponse } from "@rome/api-types/people";
import { runWithSessionActor, type SessionActor } from "../../lib/session-actor.js";
import { buildTestDeps, createTestDb, type TestDb, type TestDeps } from "../../test/helpers.js";
import { peopleRoutes } from "./people.js";

// POST /people/link-code: a redeemed code makes its sender the guardian, so the
// route hands one only to the guardian, on the dashboard's own origin.

describe("People link code API", () => {
  let testDb: TestDb;
  let deps: TestDeps;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
  });
  afterEach(() => testDb.close());

  function appAs(actor: SessionActor): Hono {
    const app = new Hono();
    app.use("*", (_c, next) => runWithSessionActor(actor, next));
    return app.route("/", peopleRoutes(deps));
  }
  const guardian: SessionActor = { kind: "guardian", userId: "owner", via: "cookie" };
  const sameOrigin = { method: "POST", headers: { "sec-fetch-site": "same-origin" } };

  it("gives the guardian a fresh code each time, uncached, and voids the last", async () => {
    const app = appAs(guardian);
    const first = await app.request("/people/link-code", sameOrigin);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const { code, expiresAt } = (await first.json()) as LinkCodeResponse;
    expect(code).toMatch(/^ROME-/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    await app.request("/people/link-code", sameOrigin);
    expect(deps.guardianLinkCodes.redeem(code)).toBe(false);
  });

  it("refuses anyone but the guardian, and a cross-site request", async () => {
    for (const actor of [
      { kind: "anonymous" },
      { kind: "visitor", accountId: "guest", email: "guest@example.com" },
    ] as SessionActor[]) {
      expect((await appAs(actor).request("/people/link-code", sameOrigin)).status).toBe(403);
    }
    const crossSite = await appAs(guardian).request("/people/link-code", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site", origin: "https://attacker.example" },
    });
    expect(crossSite.status).toBe(403);
  });
});
