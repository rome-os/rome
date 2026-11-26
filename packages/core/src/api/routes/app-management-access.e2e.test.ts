/**
 * Who reaches the app management routes core serves under `/api/apps/<appId>`
 * while the app is shared. Each request goes through the `forward_auth` probe
 * and then the route, as Caddy sends it.
 */
import { afterAll, beforeAll, describe, expect, it } from "@rstest/core";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "../index.js";
import {
  COOKIE_NAME,
  VISITOR_COOKIE_NAME,
  createSession,
  createVisitorSession,
} from "../../access/auth.js";
import { inviteMember, memberContext } from "../../access/application/members.js";
import { APP_PERMISSIONS_SETTING_KEY } from "../../apps/app-permissions.js";
import type { AppCatalog } from "../../apps/catalog.js";
import type { AppManager } from "../../apps/manager.js";
import type { ResolvedApp } from "../../apps/state.js";
import { guardianAuth, settings } from "../../db/schema.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

const LINK_APP = "link-shared";
const LISTED_APP = "email-shared";
const PRIVATE_APP = "not-shared";
const LISTED_EMAIL = "listed@example.com";
const TEAMMATE_EMAIL = "teammate@example.com";

const visitorCookie = (email: string) =>
  `${VISITOR_COOKIE_NAME}=${createVisitorSession(`acct-${email}`, email)}`;
const GUARDIAN = `${COOKIE_NAME}=${createSession("owner")}`;
const TEAMMATE = visitorCookie(TEAMMATE_EMAIL);

const OUTSIDERS = [
  { who: "a signed-out caller of a link-shared app", appId: LINK_APP, cookie: null },
  {
    who: "a signed-in visitor of a link-shared app",
    appId: LINK_APP,
    cookie: visitorCookie("anyone@example.com"),
  },
  {
    who: "a listed visitor of an email-shared app",
    appId: LISTED_APP,
    cookie: visitorCookie(LISTED_EMAIL),
  },
];
const TEAM = [
  { who: "the guardian", cookie: GUARDIAN },
  { who: "a teammate", cookie: TEAMMATE },
];

const tmp = path.join(os.tmpdir(), `rome-app-management-access-${process.pid}-${Date.now()}`);
const testDb = createTestDb();

beforeAll(async () => {
  await fs.mkdir(tmp, { recursive: true });
  await fs.writeFile(path.join(tmp, "icon.svg"), "<svg/>");
  await fs.writeFile(
    path.join(tmp, "api.mjs"),
    `export function createApiHandler() {
      return { async handle(request) { return Response.json({ app: request.path.join("/") }); } };
    }`,
  );
  await testDb.db.insert(guardianAuth).values({
    id: "seat",
    userId: "owner",
    passwordHash: "unused",
    onboardingComplete: true,
    createdAt: new Date(0),
  });
  await testDb.db.insert(settings).values([
    {
      key: APP_PERMISSIONS_SETTING_KEY,
      value: {
        allowedApps: [LINK_APP, "updates"],
        cloudEmailAccess: { [LISTED_APP]: [LISTED_EMAIL] },
      },
      updatedAt: new Date(0),
    },
  ]);
  await inviteMember(memberContext(testDb.db), TEAMMATE_EMAIL);
});

afterAll(async () => {
  testDb.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

function installedApp(appId: string): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: path.join(tmp, "no-such-bundle") },
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
    rootPath: tmp,
    resolveRoot: tmp,
    displayName: appId,
    iconAbsolutePath: path.join(tmp, "icon.svg"),
    artifacts: { agent: [], action: [], skill: [], hook: [] },
    web: {
      appId,
      version: "0.0.1",
      entry: "entry.js",
      styles: [],
      assetVersion: "abcdef123456",
      displayName: appId,
      manifestPath: path.join(tmp, "web-manifest.json"),
      distPath: tmp,
    },
    api: { appId, entryPath: path.join(tmp, "api.mjs"), noAuth: false, relayWebhook: null },
    db: null,
  };
}

async function buildInstance() {
  const apps = new Map(
    [LINK_APP, LISTED_APP, PRIVATE_APP].map((appId) => [appId, installedApp(appId)]),
  );
  const appCatalog = {
    get: (appId: string) => apps.get(appId) ?? null,
    list: () => [...apps.values()],
    listArtifacts: () => [],
    subscribe: () => () => {},
  } as unknown as AppCatalog;
  const appManager = {
    uninstall: async (appId: string) => ({ alreadyAbsent: !apps.delete(appId) }),
    setEnabled: async (appId: string, enabled: boolean) => {
      const app = apps.get(appId);
      if (app) apps.set(appId, { ...app, enabled });
    },
  } as unknown as AppManager;
  const deps = { ...(await buildTestDeps(testDb.db)), appCatalog, appManager, appsRoot: tmp };
  return { app: buildApp(deps, { port: 0, host: "127.0.0.1" }).app, apps };
}

type Instance = Awaited<ReturnType<typeof buildInstance>>;

interface Call {
  method: string;
  path: string;
}

// Every route the running app serves under `/api/apps/:appId` itself. The
// `/api/apps/:appId/*` fall-through is the app's own API, not core's.
function coreRoutes({ app }: Instance): Call[] {
  const calls = new Map<string, Call>();
  for (const { method, path: pattern } of app.routes) {
    if (method === "ALL" || !pattern.startsWith("/api/apps/:appId")) continue;
    calls.set(`${method} ${pattern}`, { method, path: pattern });
  }
  return [...calls.values()];
}

const PAGE_ROUTES = ["/api/apps/:appId/icon", "/api/apps/:appId/manifest"];
const managementRoutes = (instance: Instance) =>
  coreRoutes(instance).filter((call) => !PAGE_ROUTES.includes(call.path));

const BODIES: Record<string, unknown> = { DELETE: { purge: true }, PATCH: { enabled: false } };

function callRoute(
  { app }: Instance,
  { method, path: pattern }: Call,
  appId: string,
  cookie: string | null,
  env?: object,
) {
  const body = BODIES[method] ?? {};
  return app.request(
    pattern.replace(":appId", appId),
    {
      method,
      headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    },
    env,
  );
}

async function callThroughEdge(
  instance: Instance,
  call: Call,
  appId: string,
  cookie: string | null,
) {
  const verdict = await instance.app.request("/api/auth/verify", {
    headers: {
      "x-forwarded-uri": call.path.replace(":appId", appId),
      "x-forwarded-method": call.method,
      ...(cookie ? { cookie } : {}),
    },
  });
  return verdict.status === 204 ? callRoute(instance, call, appId, cookie) : verdict;
}

describe("app management routes of a shared app", () => {
  for (const { who, appId, cookie } of OUTSIDERS) {
    it(`are closed to ${who}`, async () => {
      const instance = await buildInstance();
      const routes = managementRoutes(instance);
      expect(routes.length).toBeGreaterThan(0);
      const answers = [];
      for (const call of routes) {
        const { status } = await callThroughEdge(instance, call, appId, cookie);
        answers.push(
          `${call.method} ${call.path}: ${[401, 403].includes(status) ? "refused" : status}`,
        );
      }
      expect(answers).toEqual(routes.map((call) => `${call.method} ${call.path}: refused`));
      expect(instance.apps.get(appId)?.enabled).toBe(true);
    });

    it(`refuse ${who} behind the edge too`, async () => {
      const instance = await buildInstance();
      for (const call of managementRoutes(instance)) {
        const { status } = await callRoute(instance, call, appId, cookie);
        expect([401, 403], `${call.method} ${call.path}`).toContain(status);
      }
      expect(instance.apps.get(appId)?.enabled).toBe(true);
    });

    it(`leave what the page reads open to ${who}`, async () => {
      const instance = await buildInstance();
      const get = (sub: string) =>
        callThroughEdge(
          instance,
          { method: "GET", path: `/api/apps/:appId/${sub}` },
          appId,
          cookie,
        );
      expect((await get("icon")).status).toBe(200);
      expect((await get("manifest")).status).toBe(200);
      const own = await callThroughEdge(
        instance,
        { method: "POST", path: "/api/apps/:appId/orders/1/publish" },
        appId,
        cookie,
      );
      expect(await own.json()).toEqual({ app: "orders/1/publish" });
    });
  }

  it("are closed to a percent-encoded spelling", async () => {
    const instance = await buildInstance();
    const call = { method: "POST", path: "/api/apps/:appId/%70ublish?x=1" };
    expect((await callThroughEdge(instance, call, LINK_APP, null)).status).toBe(401);
  });

  it("keep the update listing closed when an app named updates is shared", async () => {
    const instance = await buildInstance();
    const call = { method: "GET", path: "/api/apps/updates" };
    expect((await callThroughEdge(instance, call, "", null)).status).toBe(401);
  });

  for (const appId of [LINK_APP, LISTED_APP, PRIVATE_APP]) {
    for (const { who, cookie } of TEAM) {
      it(`answer ${who} for ${appId}`, async () => {
        const instance = await buildInstance();
        const call = (method: string, sub = "") =>
          callThroughEdge(instance, { method, path: `/api/apps/:appId${sub}` }, appId, cookie);
        expect((await call("GET")).status).toBe(200);
        // Past the check, publishing stops at the fixture's missing bundle.
        expect((await call("POST", "/publish")).status).toBe(409);
        expect((await call("PATCH")).status).toBe(200);
        expect(instance.apps.get(appId)?.enabled).toBe(false);
        expect((await call("DELETE")).status).toBe(200);
        expect(instance.apps.has(appId)).toBe(false);
      });
    }
  }

  it("answer a loopback caller with no session", async () => {
    const instance = await buildInstance();
    const loopback = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
    const call = (method: string, sub = "") =>
      callRoute(instance, { method, path: `/api/apps/:appId${sub}` }, PRIVATE_APP, null, loopback);
    expect((await call("GET")).status).toBe(200);
    expect((await call("POST", "/publish")).status).toBe(409);
    expect((await call("PATCH")).status).toBe(200);
    expect((await call("DELETE")).status).toBe(200);
    expect(instance.apps.has(PRIVATE_APP)).toBe(false);
  });
});
