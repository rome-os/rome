/**
 * Black-box behavior of `/api/auth/verify` — the probe endpoint Caddy
 * `forward_auth` hits on every proxied request.
 *
 * Auth lives at the Caddy edge; verify's response (204 / 401) tells Caddy
 * whether to proxy or reject. These tests pin the decision tree for the
 * forwarded paths that matter:
 *
 *   - Static public paths (login, health, etc.) → 204 with no cookie
 *   - `/api/app-api/<appId>/<sub>` where the resolved app declares
 *     `api.noAuth` covering `<sub>` → 204 with no cookie (lets external
 *     webhooks / third-party callbacks through)
 *   - Anything else `/api/*` with no cookie → 401
 *
 * The dashboard-side `/api/apps/<appId>/*` surface is intentionally NOT
 * consulted against `noAuth` — those always require a session.
 */
import { afterAll, describe, expect, it } from "@rstest/core";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { buildApp } from "../index.js";
import {
  COOKIE_NAME,
  JWT_SECRET,
  VISITOR_COOKIE_NAME,
  createGuardianSession,
  createVisitorSession,
} from "../../lib/auth.js";
import type { ApiConfig, ApiDeps } from "../deps.js";
import type { AppCatalog } from "../../apps/catalog.js";
import type { AppView, ResolvedApp } from "../../apps/state.js";
import { settings } from "../../db/schema.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "../../lib/dashboard-access-config.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

function buildResolvedApp(
  appId: string,
  noAuth: boolean | string[],
  options: { web?: boolean } = {},
): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
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
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: [], skill: [], hook: [] },
    web: options.web
      ? {
          appId,
          version: "0.0.1",
          entry: "entry.js",
          styles: [],
          assetVersion: "abcdef123456",
          displayName: appId,
          routing: "client",
          manifestPath: "/tmp/unused-web-manifest.json",
          distPath: "/tmp/unused-dist",
        }
      : null,
    api: { appId, entryPath: "/tmp/unused-entry.js", noAuth, relayWebhook: null },
    db: null,
  };
}

const testDb = createTestDb();
afterAll(() => testDb.close());

async function stubDeps(
  apps: ResolvedApp[],
  options: {
    allowedApps?: string[];
    cloudEmailAccess?: Record<string, string[]>;
    dashboardEmailAccess?: string[];
  } = {},
): Promise<ApiDeps> {
  const map = new Map<string, ResolvedApp>();
  for (const a of apps) map.set(a.appId, a);
  const catalog = {
    get: (appId: string): AppView | ResolvedApp | null => map.get(appId) ?? null,
    list: () => Array.from(map.values()),
    subscribe: () => () => {},
  } as unknown as AppCatalog;
  // Drive the allow-lists through persisted settings: buildTestDeps snapshots
  // them the way the daemon does at boot, so these tests exercise the real load
  // path instead of patching access state by hand. The DB is shared
  // module-wide — reset the rows so each test's deps see only their own policy.
  testDb.db.delete(settings).where(eq(settings.key, "publicAccess")).run();
  testDb.db.delete(settings).where(eq(settings.key, DASHBOARD_ACCESS_SETTING_KEY)).run();
  if (options.allowedApps || options.cloudEmailAccess) {
    testDb.db
      .insert(settings)
      .values({
        key: "publicAccess",
        value: {
          enableAccessControl: true,
          allowedApps: options.allowedApps ?? [],
          cloudEmailAccess: options.cloudEmailAccess ?? {},
        },
        updatedAt: new Date(),
      })
      .run();
  }
  if (options.dashboardEmailAccess) {
    testDb.db
      .insert(settings)
      .values({
        key: DASHBOARD_ACCESS_SETTING_KEY,
        value: {
          cloudEmailAccess: options.dashboardEmailAccess,
        },
        updatedAt: new Date(),
      })
      .run();
  }
  return { ...(await buildTestDeps(testDb.db)), appCatalog: catalog };
}

const TEST_CONFIG: ApiConfig = { port: 0, host: "127.0.0.1" };

function buildHost(deps: ApiDeps) {
  return buildApp(deps, TEST_CONFIG).app;
}

function verifyRequest(
  host: ReturnType<typeof buildHost>,
  forwardedUri: string,
  headers: Record<string, string> = {},
) {
  return host.request("/api/auth/verify", {
    headers: { "X-Forwarded-Uri": forwardedUri, ...headers },
  });
}

function validCookieHeader(): Record<string, string> {
  const token = jwt.sign({ userId: "u1" }, JWT_SECRET, { expiresIn: "1h" });
  return { cookie: `${COOKIE_NAME}=${token}` };
}

function validVisitorCookieHeader(email: string): Record<string, string> {
  const token = createVisitorSession("acct-1", email);
  return { cookie: `${VISITOR_COOKIE_NAME}=${token}` };
}

describe("/api/auth/verify", () => {
  it("returns 204 for static public paths without a cookie", async () => {
    const host = buildHost(await stubDeps([]));
    const res = await verifyRequest(host, "/api/health");
    expect(res.status).toBe(204);
  });

  it("returns 204 for non-/api/* (SPA) paths without a cookie", async () => {
    const host = buildHost(await stubDeps([]));
    const res = await verifyRequest(host, "/dashboard");
    expect(res.status).toBe(204);
  });

  it("returns 401 for private /api/* paths without a cookie", async () => {
    const host = buildHost(await stubDeps([]));
    const res = await verifyRequest(host, "/api/people");
    expect(res.status).toBe(401);
  });

  it("returns 204 for the connect return leg without a cookie", async () => {
    const host = buildHost(await stubDeps([]));
    const res = await verifyRequest(host, "/api/setups/return");
    expect(res.status).toBe(204);
  });

  it("keeps the rest of /api/setups/* private", async () => {
    // The return leg is listed as an exact path, so the sibling routes a
    // browser must never reach on its own stay behind the cookie.
    const host = buildHost(await stubDeps([]));
    for (const uri of ["/api/setups/abc", "/api/setups/abc/input", "/api/setups/abc/cancel"]) {
      const res = await verifyRequest(host, uri);
      expect(res.status, uri).toBe(401);
    }
  });

  it("accepts a raw guardian session explicitly injected by a Native client", async () => {
    const host = buildHost(await stubDeps([]));
    const session = createGuardianSession("native-account");
    const res = await verifyRequest(host, "/api/people", {
      cookie: `${COOKIE_NAME}=${session.token}`,
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("X-Rome-User-Id")).toBe("native-account");
  });

  it("returns 204 when forwardedUri targets an app declaring noAuth: true", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("noauth-app", true)]));
    const res = await verifyRequest(host, "/api/app-api/noauth-app/whatever");
    expect(res.status).toBe(204);
  });

  it("returns 204 when forwardedUri targets a noAuth allow-list match", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("partial", ["/webhooks/*"])]));
    const res = await verifyRequest(host, "/api/app-api/partial/webhooks/stripe/event");
    expect(res.status).toBe(204);
  });

  it("returns 401 when forwardedUri targets a sub-path outside the noAuth list", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("partial", ["/webhooks/*"])]));
    const res = await verifyRequest(host, "/api/app-api/partial/admin/secret");
    expect(res.status).toBe(401);
  });

  it("returns 401 when forwardedUri targets an app with noAuth: false", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("authed", false)]));
    const res = await verifyRequest(host, "/api/app-api/authed/whatever");
    expect(res.status).toBe(401);
  });

  it("fails closed (401) when forwardedUri references an unknown app", async () => {
    const host = buildHost(await stubDeps([]));
    const res = await verifyRequest(host, "/api/app-api/ghost/webhook");
    expect(res.status).toBe(401);
  });

  it("does not apply noAuth to the dashboard-side /api/apps/<id>/* surface", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("noauth-app", true)]));
    const res = await verifyRequest(host, "/api/apps/noauth-app/anything");
    expect(res.status).toBe(401);
  });

  it("returns 204 for /api/apps/<id>/* when the app is in publicAccess.allowedApps", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("public-app", false)], { allowedApps: ["public-app"] }),
    );
    const iconRes = await verifyRequest(host, "/api/apps/public-app/icon");
    expect(iconRes.status).toBe(204);
    const dispatcherRes = await verifyRequest(host, "/api/apps/public-app/anything/here");
    expect(dispatcherRes.status).toBe(204);
    const rootRes = await verifyRequest(host, "/api/apps/public-app");
    expect(rootRes.status).toBe(204);
  });

  it("returns 204 for /api/app-api/<id>/* when the app is in publicAccess.allowedApps", async () => {
    // No manifest noAuth — public toggle alone should be enough.
    const host = buildHost(
      await stubDeps([buildResolvedApp("public-app", false)], { allowedApps: ["public-app"] }),
    );
    const res = await verifyRequest(host, "/api/app-api/public-app/some/handler");
    expect(res.status).toBe(204);
  });

  it("matches a scoped app id encoded as one path segment", async () => {
    const appId = "@foo/bar";
    const host = buildHost(
      await stubDeps([buildResolvedApp(appId, false)], { allowedApps: [appId] }),
    );
    const res = await verifyRequest(host, "/api/app-api/%40foo%2Fbar/some/handler");
    expect(res.status).toBe(204);
  });

  it("returns 401 for /api/apps/<id>/* when allowedApps does not include the app", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("other-app", false)], { allowedApps: ["other-app"] }),
    );
    const res = await verifyRequest(host, "/api/apps/private-app/icon");
    expect(res.status).toBe(401);
  });

  it("returns 401 for /api/apps/<id>/* with an empty publicAccess allow-list", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("any", false)]));
    const res = await verifyRequest(host, "/api/apps/any/icon");
    expect(res.status).toBe(401);
  });

  it("returns 204 for a cloud-email app manifest without a visitor cookie", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(host, "/api/apps/restricted/manifest?mode=full");
    expect(res.status).toBe(204);
  });

  it("returns 401 for a cloud-email app API without a visitor cookie", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(host, "/api/apps/restricted/anything");
    expect(res.status).toBe(401);
  });

  it("returns 204 for a cloud-email app API with a guardian cookie", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(host, "/api/apps/restricted/anything", validCookieHeader());
    expect(res.status).toBe(204);
    expect(res.headers.get("X-Rome-User-Id")).toBe("u1");
  });

  it("returns 204 for a cloud-email app API when the visitor email is allowed", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(
      host,
      "/api/apps/restricted/anything",
      validVisitorCookieHeader("ada@example.com"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("X-Rome-Visitor-Email")).toBe("ada@example.com");
  });

  it("returns 403 for a cloud-email app API when the visitor email is not allowed", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(
      host,
      "/api/apps/restricted/anything",
      validVisitorCookieHeader("lin@example.com"),
    );
    expect(res.status).toBe(403);
  });

  it("returns 204 for private dashboard APIs when the visitor email has dashboard access", async () => {
    const host = buildHost(await stubDeps([], { dashboardEmailAccess: ["ada@example.com"] }));
    const res = await verifyRequest(
      host,
      "/api/settings",
      validVisitorCookieHeader("ada@example.com"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("X-Rome-Visitor-Email")).toBe("ada@example.com");
  });

  it("returns 403 for private dashboard APIs when a visitor cookie is not dashboard-allowed", async () => {
    const host = buildHost(await stubDeps([], { dashboardEmailAccess: ["ada@example.com"] }));
    const res = await verifyRequest(
      host,
      "/api/settings",
      validVisitorCookieHeader("lin@example.com"),
    );
    expect(res.status).toBe(403);
  });

  it("lets a dashboard-allowed visitor through cloud-email app APIs", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["lin@example.com"] },
        dashboardEmailAccess: ["ada@example.com"],
      }),
    );
    const res = await verifyRequest(
      host,
      "/api/apps/restricted/anything",
      validVisitorCookieHeader("ada@example.com"),
    );
    expect(res.status).toBe(204);
  });

  it("returns 401 for cloud-email app assets without a visitor cookie", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(host, "/app-assets/restricted/v1/entry.js");
    expect(res.status).toBe(401);
  });

  it("returns 204 for cloud-email app assets with a guardian cookie", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(
      host,
      "/app-assets/restricted/v1/entry.js",
      validCookieHeader(),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("X-Rome-User-Id")).toBe("u1");
  });

  it("returns 204 for cloud-email app assets when the visitor email is allowed", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false)], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await verifyRequest(
      host,
      "/app-assets/restricted/v1/entry.js",
      validVisitorCookieHeader("ada@example.com"),
    );
    expect(res.status).toBe(204);
  });

  it("marks cloud-email app manifest access denied without guardian or visitor auth", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false, { web: true })], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await host.request("/api/apps/restricted/manifest?mode=full");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      guardianAccessAllowed?: boolean;
      callerAccessAllowed?: boolean;
      bootstrap?: { caller?: { kind?: string } };
    };
    expect(body.guardianAccessAllowed).toBe(false);
    expect(body.callerAccessAllowed).toBe(false);
    expect(body.bootstrap?.caller).toEqual({ kind: "anonymous" });
  });

  it("marks cloud-email app manifest access allowed with a guardian cookie", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false, { web: true })], {
        cloudEmailAccess: { restricted: ["ada@example.com"] },
      }),
    );
    const res = await host.request("/api/apps/restricted/manifest?mode=full", {
      headers: validCookieHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      guardianAccessAllowed?: boolean;
      callerAccessAllowed?: boolean;
      bootstrap?: { caller?: { kind?: string } };
    };
    expect(body.guardianAccessAllowed).toBe(true);
    expect(body.callerAccessAllowed).toBe(true);
    expect(body.bootstrap?.caller?.kind).toBe("guardian");
  });

  it("marks cloud-email app manifest access allowed with dashboard visitor access", async () => {
    const host = buildHost(
      await stubDeps([buildResolvedApp("restricted", false, { web: true })], {
        cloudEmailAccess: { restricted: ["lin@example.com"] },
        dashboardEmailAccess: ["ada@example.com"],
      }),
    );
    const res = await host.request("/api/apps/restricted/manifest?mode=full", {
      headers: validVisitorCookieHeader("ada@example.com"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      dashboardAccessAllowed?: boolean;
      callerAccessAllowed?: boolean;
      bootstrap?: { caller?: { kind?: string; email?: string } };
    };
    expect(body.dashboardAccessAllowed).toBe(true);
    expect(body.callerAccessAllowed).toBe(true);
    expect(body.bootstrap?.caller?.kind).toBe("visitor");
    expect(body.bootstrap?.caller?.email).toBe("ada@example.com");
  });

  it("returns 204 for an authed app once a valid cookie is presented", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("authed", false)]));
    const res = await verifyRequest(host, "/api/app-api/authed/whatever", validCookieHeader());
    expect(res.status).toBe(204);
  });

  it("ignores query strings when matching the noAuth list", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("partial", ["/webhooks/*"])]));
    const res = await verifyRequest(host, "/api/app-api/partial/webhooks/stripe?signature=abc");
    expect(res.status).toBe(204);
  });

  it("falls through to cookie check on a structurally invalid app-api path", async () => {
    const host = buildHost(await stubDeps([buildResolvedApp("authed", true)]));
    // A slash is accepted only as part of a complete valid scoped app id.
    const res = await verifyRequest(host, "/api/app-api/authed%2Fbar/x");
    expect(res.status).toBe(401);
  });
});
