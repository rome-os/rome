/**
 * Black-box spec for `request.caller` on the app-api dispatch path
 * (api/routes/app-api.ts): the host resolves the caller identity server-side
 * from primary material (guardian cookie, visitor cookie) and hands it to the
 * app handler, while stripping the forwarded identity headers
 * (`X-Rome-User-Id`, `X-Rome-Visitor-*`) an external caller could spoof on a
 * public app.
 *
 * The fixture mounts the real production dashboard route (the same module
 * `buildApp` mounts) with a temp-file API entry that echoes what the handler
 * observed, so the assertions cover the wire behavior an app builder programs
 * against — not internals.
 */
import { afterAll, describe, expect, it } from "@rstest/core";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { Hono } from "hono";
import { appApiDashboardRoutes } from "./app-api.js";
import {
  COOKIE_NAME,
  VISITOR_COOKIE_NAME,
  createSession,
  createVisitorSession,
} from "../../lib/auth.js";
import type { ApiDeps } from "../deps.js";
import type { AppCatalog } from "../../apps/catalog.js";
import type { AppView, ResolvedApp } from "../../apps/state.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";

const APP_ID = "caller-spec-app";

function buildResolvedApp(appId: string, apiEntryPath: string): ResolvedApp {
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
    web: null,
    api: { appId, entryPath: apiEntryPath, noAuth: false, relayWebhook: null },
    db: null,
  };
}

const testDb = createTestDb();
afterAll(() => testDb.close());

async function buildHost(appId: string = APP_ID) {
  const entryPath = path.join(
    os.tmpdir(),
    `rome-app-api-caller-${Date.now()}-${Math.random()}.mjs`,
  );
  await fs.writeFile(
    entryPath,
    `export function createApiHandler() {
      return {
        async handle(request) {
          return new Response(JSON.stringify({
            caller: request.caller,
            // viewer is intentionally NOT part of the request contract; echo
            // whatever is (not) there to prove the session never leaks.
            leakedViewer: request.viewer ?? null,
            userIdHeader: request.headers["x-rome-user-id"] ?? null,
            visitorEmailHeader: request.headers["x-rome-visitor-email"] ?? null,
          }), { headers: { "content-type": "application/json" } });
        }
      };
    }`,
    "utf8",
  );

  const resolved = buildResolvedApp(appId, entryPath);
  const catalog = {
    get: (candidate: string): AppView | ResolvedApp | null =>
      candidate === appId ? resolved : null,
    list: () => [resolved],
    subscribe: () => () => {},
  } as unknown as AppCatalog;
  const deps: ApiDeps = { ...(await buildTestDeps(testDb.db)), appCatalog: catalog };
  // Same mounting shape as api/index.ts: the dashboard app-api route under /api.
  return new Hono().route("/api", appApiDashboardRoutes(deps));
}

interface EchoBody {
  caller: { kind: string; userId?: string; via?: string; accountId?: string; email?: string };
  leakedViewer: unknown;
  userIdHeader: string | null;
  visitorEmailHeader: string | null;
}

async function echo(
  host: Awaited<ReturnType<typeof buildHost>>,
  headers: Record<string, string>,
  appId: string = APP_ID,
) {
  const res = await host.request(`/api/apps/${encodeURIComponent(appId)}/state`, { headers });
  expect(res.status).toBe(200);
  return (await res.json()) as EchoBody;
}

describe("request.caller resolution on app-api dispatch", () => {
  it("dispatches a scoped app id encoded as one path segment", async () => {
    const appId = "@foo/bar";
    const host = await buildHost(appId);
    const body = await echo(host, {}, appId);
    expect(body.caller).toEqual({ kind: "anonymous" });
  });

  it("resolves a valid guardian session cookie as the guardian", async () => {
    const host = await buildHost();
    const body = await echo(host, { cookie: `${COOKIE_NAME}=${createSession("u1")}` });
    expect(body.caller).toEqual({ kind: "guardian", userId: "u1", via: "cookie" });
  });

  it("resolves a valid visitor session cookie as a visitor, without leaking the session", async () => {
    const host = await buildHost();
    const body = await echo(host, {
      cookie: `${VISITOR_COOKIE_NAME}=${createVisitorSession(
        "acct-1",
        "ada@example.com",
        "favor-viewer-token",
      )}`,
    });
    expect(body.caller).toEqual({ kind: "visitor", accountId: "acct-1", email: "ada@example.com" });
    // The visitor session (and its favor token) stays host-side for ctx.favors;
    // the request hands the handler only the resolved caller.
    expect(body.leakedViewer).toBeNull();
  });

  it("resolves no session as anonymous", async () => {
    const host = await buildHost();
    const body = await echo(host, {});
    expect(body.caller).toEqual({ kind: "anonymous" });
  });

  it("prefers guardian over a coexisting visitor session", async () => {
    const host = await buildHost();
    const body = await echo(host, {
      cookie: `${COOKIE_NAME}=${createSession("u1")}; ${VISITOR_COOKIE_NAME}=${createVisitorSession(
        "acct-1",
        "ada@example.com",
      )}`,
    });
    expect(body.caller).toEqual({ kind: "guardian", userId: "u1", via: "cookie" });
    expect(body.leakedViewer).toBeNull();
  });

  it("strips spoofed identity headers and does not let them influence caller", async () => {
    const host = await buildHost();
    const body = await echo(host, {
      "x-rome-user-id": "guardian",
      "x-rome-visitor-email": "spoof@example.com",
    });
    expect(body.caller).toEqual({ kind: "anonymous" });
    expect(body.userIdHeader).toBeNull();
    expect(body.visitorEmailHeader).toBeNull();
  });

  it("ignores a garbage session cookie", async () => {
    const host = await buildHost();
    const body = await echo(host, { cookie: `${COOKIE_NAME}=not-a-jwt` });
    expect(body.caller).toEqual({ kind: "anonymous" });
  });
});
