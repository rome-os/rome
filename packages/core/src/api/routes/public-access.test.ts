import { describe, it, expect, beforeEach, afterEach } from "@rstest/core";
import { Hono } from "hono";
import { publicAccessRoutes } from "./public-access.js";
import { generateCaddyfile } from "../../lib/caddyfile-generator.js";
import { Permissions } from "../../access/permissions.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";

describe("Public-access API", () => {
  let testDb: TestDb;
  let app: Hono;
  let deps: ApiDeps;
  let permissions: Permissions;

  beforeEach(async () => {
    testDb = createTestDb();
    permissions = new Permissions();
    deps = { ...(await buildTestDeps(testDb.db)), permissions };
    app = new Hono().route("/", publicAccessRoutes(deps));
  });

  afterEach(() => {
    testDb.close();
  });

  const putConfig = (body: string) =>
    app.request("/public-access", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });

  describe("GET /public-access", () => {
    it("returns the default config when no row is persisted", async () => {
      const res = await app.request("/public-access");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        allowedApps: [],
        cloudEmailAccess: {},
      });
    });

    it("returns the normalized config when a row exists", async () => {
      await deps.settingsRepo!.set("publicAccess", {
        // A flag retired with the tailnet-only mode: dropped on read.
        enableAccessControl: true,
        allowedApps: ["inbox", "inbox", "bad slug!", "news"],
        cloudEmailAccess: {
          inbox: ["A@example.com", "bad email", "a@example.com"],
          "bad slug!": ["ignored@example.com"],
        },
      });
      const res = await app.request("/public-access");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        allowedApps: string[];
        cloudEmailAccess: Record<string, string[]>;
      };
      expect(body).not.toHaveProperty("enableAccessControl");
      expect(body.allowedApps.sort()).toEqual(["inbox", "news"]);
      expect(body.cloudEmailAccess).toEqual({ inbox: ["a@example.com"] });
    });
  });

  describe("PUT /public-access", () => {
    it("persists the normalized config and refreshes auth state", async () => {
      const res = await putConfig(
        JSON.stringify({
          allowedApps: ["inbox", "not a slug"],
          cloudEmailAccess: { inbox: ["Ada@Example.com"] },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // The config survives a round-trip through the DB, normalized.
      const getRes = await app.request("/public-access");
      expect(await getRes.json()).toEqual({
        allowedApps: ["inbox"],
        cloudEmailAccess: { inbox: ["ada@example.com"] },
      });

      // The in-memory snapshot read by /api/auth/verify follows the write.
      expect(permissions.get("inbox").anyoneWithLink).toBe(true);
      expect([...permissions.get("inbox").listedEmails]).toEqual(["ada@example.com"]);
    });

    it("stores only the app policy when the body carries the retired enableAccessControl flag", async () => {
      const res = await putConfig(
        JSON.stringify({ enableAccessControl: true, allowedApps: ["inbox"] }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      const stored = await deps.settingsRepo!.get("publicAccess");
      expect(stored).toEqual({ allowedApps: ["inbox"], cloudEmailAccess: {} });
      expect(permissions.get("inbox").anyoneWithLink).toBe(true);

      // The proxy shape is independent of the policy: the dashboard stays
      // reachable and /api/* still goes through the verify probe.
      const caddyfile = generateCaddyfile();
      expect(caddyfile).toContain("forward_auth");
      expect(caddyfile).not.toContain("not_public");
    });

    it("accepts an empty body (null → defaults)", async () => {
      const res = await putConfig("not-json");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(permissions.get("inbox").anyoneWithLink).toBe(false);
    });
  });

  describe("PUT /public-access/:appId", () => {
    const PAGES: Record<string, boolean> = { "@ray/demo": true, worker: false };

    beforeEach(() => {
      deps = {
        ...deps,
        appCatalog: {
          get: (appId: string) =>
            appId in PAGES
              ? ({ appId, manifest: {}, web: PAGES[appId] ? {} : undefined } as never)
              : null,
        } as unknown as ApiDeps["appCatalog"],
      };
      app = new Hono().route("/", publicAccessRoutes(deps));
    });

    const putApp = (appId: string, body: unknown) =>
      app.request(`/public-access/${encodeURIComponent(appId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify(body),
      });

    it("sets one app and keeps the others", async () => {
      await putConfig(JSON.stringify({ allowedApps: ["inbox"], cloudEmailAccess: {} }));
      const res = await putApp("@ray/demo", { mode: "cloud-email", emails: ["Ada@Example.com"] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        before: { mode: "private", emails: [] },
        after: { mode: "cloud-email", emails: ["ada@example.com"] },
      });
      expect(await (await app.request("/public-access")).json()).toEqual({
        allowedApps: ["inbox"],
        cloudEmailAccess: { "@ray/demo": ["ada@example.com"] },
      });
      expect([...permissions.get("@ray/demo").listedEmails]).toEqual(["ada@example.com"]);
    });

    it("refuses an unknown app, an app with no page, and a bad request", async () => {
      expect((await putApp("missing", { mode: "public" })).status).toBe(404);
      expect((await putApp("worker", { mode: "public" })).status).toBe(409);
      expect((await putApp("@ray/demo", { mode: "everyone" })).status).toBe(400);
      expect((await putApp("@ray/demo", { mode: "cloud-email", emails: [] })).status).toBe(400);
      expect(permissions.get("@ray/demo").anyoneWithLink).toBe(false);
    });

    it("refuses a cross-site request", async () => {
      const res = await app.request("/public-access/%40ray%2Fdemo", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "sec-fetch-site": "cross-site" },
        body: JSON.stringify({ mode: "public" }),
      });
      expect(res.status).toBe(403);
    });
  });
});
