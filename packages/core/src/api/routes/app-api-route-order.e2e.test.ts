/**
 * Black-box regression: `/api/apps/<appId>/icon` for an app without an
 * API entrypoint must reach the static icon handler in `appsRoutes`,
 * not the catch-all dispatcher in `appApiDashboardRoutes`.
 *
 * Before the fix, `appApiRoutes` registered both `/app-api/*` and
 * `/apps/:appId/*` and was mounted ABOVE `appsRoutes`, so a request to
 * `/api/apps/<appId>/icon` for an app without an API entrypoint
 * (assistant, inbox, system, …) hit the dispatcher and 500'd with
 * `app_api_error: App "<id>" has no API entrypoint` — the AppStore UI
 * couldn't load any installed-app icons.
 *
 * The fixture drives the real production `buildApp` so any future
 * regression in mount ordering inside `api/index.ts` breaks this test
 * without the test file needing to mirror that order itself.
 */
import { afterAll, describe, expect, it } from "@rstest/core";
import jwt from "jsonwebtoken";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { buildApp } from "../index.js";
import { COOKIE_NAME, JWT_SECRET } from "../../lib/auth.js";
import type { ApiConfig, ApiDeps } from "../deps.js";
import type { AppCatalog } from "../../apps/catalog.js";
import type { AppView, ResolvedApp } from "../../apps/state.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

function buildResolvedApp(
  appId: string,
  overrides: { hasApi?: boolean; apiEntryPath?: string; iconAbsolutePath?: string } = {},
): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
    // `workspace.path` is the packed artifact dir post-install. The fixture
    // is route-ordering-only — no FS lookups happen against this path.
    source: { mode: "bundle", path: "/tmp/unused" },
    installedHash: "0".repeat(64),
    installedVersion: "0.0.1",
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    manifest: {
      id: appId,
      version: "0.0.1",
      description: "",
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: "/tmp/unused",
    resolveRoot: "/tmp/unused",
    displayName: appId,
    iconAbsolutePath: overrides.iconAbsolutePath,
    artifacts: { agent: [], action: [], skill: [], hook: [] },
    web: null,
    api: overrides.hasApi
      ? {
          appId,
          entryPath: overrides.apiEntryPath ?? "/tmp/unused-entry.js",
          noAuth: false,
          relayWebhook: null,
        }
      : null,
    db: null,
  };
}

const testDb = createTestDb();
afterAll(() => testDb.close());

async function stubDeps(apps: ResolvedApp[]): Promise<ApiDeps> {
  const map = new Map<string, ResolvedApp>();
  for (const a of apps) map.set(a.appId, a);
  const catalog = {
    get: (appId: string): AppView | ResolvedApp | null => map.get(appId) ?? null,
    list: () => Array.from(map.values()),
    subscribe: () => () => {},
  } as unknown as AppCatalog;
  return { ...(await buildTestDeps(testDb.db)), appCatalog: catalog };
}

const TEST_CONFIG: ApiConfig = { port: 0, host: "127.0.0.1" };

function buildHost(deps: ApiDeps) {
  return buildApp(deps, TEST_CONFIG).app;
}

function cookieHeader(): Record<string, string> {
  const token = jwt.sign({ userId: "u1" }, JWT_SECRET, { expiresIn: "1h" });
  return { cookie: `${COOKIE_NAME}=${token}` };
}

describe("/api/apps/:appId/icon route order", () => {
  it("returns 404 (no icon) for an installed app without an icon — not 500 from the app-api dispatcher", async () => {
    const deps = await stubDeps([buildResolvedApp("regression-no-such-app")]);
    const res = await buildHost(deps).request("/api/apps/regression-no-such-app/icon", {
      headers: cookieHeader(),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no icon|not found on disk/i);
    // Negative assertion: must not be the dispatcher's error envelope.
    expect(body).not.toHaveProperty("appId");
  });

  it("leaves /apps/:appId/readme to the app-api dispatcher — apps own that sub-path", async () => {
    // The app-web SDK maps `fetchAppApi("readme")` to `/api/apps/<id>/readme`,
    // so the host must NOT claim it (host README metadata lives at
    // `/api/app-readmes/:appId` instead). The fixture app has no API
    // entrypoint, so reaching the dispatcher yields its error envelope —
    // proof the request fell through rather than hitting a static handler.
    const deps = await stubDeps([buildResolvedApp("regression-no-such-app")]);
    const res = await buildHost(deps).request("/api/apps/regression-no-such-app/readme", {
      headers: cookieHeader(),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; appId: string; message: string };
    expect(body.error).toBe("app_api_error");
    expect(body.message).toMatch(/has no API entrypoint/i);
  });

  it("serves host README metadata from its own /app-readmes namespace", async () => {
    const deps = await stubDeps([buildResolvedApp("regression-no-such-app")]);
    const res = await buildHost(deps).request("/api/app-readmes/regression-no-such-app", {
      headers: cookieHeader(),
    });
    // rootPath holds no README.md → null payload, but the core envelope (not
    // the dispatcher's error) proves the platform route answered.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ appId: "regression-no-such-app", readme: null });
  });

  it("falls through to the app-api dispatcher for non-static sub-paths", async () => {
    const deps = await stubDeps([buildResolvedApp("regression-no-such-app")]);
    const res = await buildHost(deps).request("/api/apps/regression-no-such-app/some-handler", {
      headers: cookieHeader(),
    });
    // The app declares no API entrypoint, so the dispatcher rejects with its
    // own error envelope (which carries `appId`). The point of this test is
    // that the request reached the dispatcher (and not the static `/icon`
    // handler).
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; appId: string; message: string };
    expect(body.error).toBe("app_api_error");
    expect(body.appId).toBe("regression-no-such-app");
    expect(body.message).toMatch(/has no API entrypoint/i);
  });

  it("passes GET query params to app API handlers (including edge cases)", async () => {
    const entryPath = path.join(os.tmpdir(), `rome-app-api-${Date.now()}-${Math.random()}.mjs`);
    await fs.writeFile(
      entryPath,
      `export function createApiHandler() {
        return {
          async handle(request) {
            const out = {
              limit: request.query.get("limit"),
              cursor: request.query.get("cursor"),
              tags: request.query.getAll("tag"),
              q: request.query.get("q"),
              plus: request.query.get("plus"),
              rawPlus: request.query.get("rawPlus"),
            };
            return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
          }
        };
      }`,
      "utf8",
    );

    const deps = await stubDeps([
      buildResolvedApp("query-app", {
        hasApi: true,
        apiEntryPath: entryPath,
      }),
    ]);

    const res = await buildHost(deps).request(
      "/api/apps/query-app/repos?limit=50&cursor=a%2Bb&tag=alpha&tag=beta&q=hello+world&plus=a%2Bb&rawPlus=a+b",
      { headers: cookieHeader() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limit: string | null;
      cursor: string | null;
      tags: string[];
      q: string | null;
      plus: string | null;
      rawPlus: string | null;
    };
    expect(body).toEqual({
      limit: "50",
      cursor: "a+b",
      tags: ["alpha", "beta"],
      q: "hello world",
      plus: "a+b",
      rawPlus: "a b",
    });
  });
});
