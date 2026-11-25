import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { appsRoutes, deriveAppProjectPath } from "./apps.js";
import type { AppCatalog } from "../../apps/catalog.js";
import type {
  AppView,
  ArtifactKind,
  ArtifactRef,
  CatalogEvent,
  ResolvedApp,
  SubscriberHandler,
  Unsubscribe,
} from "../../apps/state.js";
import { ActionLoader } from "../../apps/actions/loader.js";
import { createEmptyLegacyArtifactBindings } from "../../apps/artifact-id.js";
import { AgentLoader } from "../../app-host/agent-loader.js";
import {
  COOKIE_NAME,
  VISITOR_COOKIE_NAME,
  createSession,
  createVisitorSession,
} from "../../access/auth.js";
import { sessionActorMiddleware } from "../../access/session-actor.js";
import { settings } from "../../db/schema.js";
import * as appPublishing from "../../apps/publish.js";
import { appApiDashboardRoutes } from "./app-api.js";
import { buildTestDeps, createTestDb } from "../../test/helpers.js";
import { entryStep } from "../../test/entry-step.js";

function buildResolvedApp(
  appId: string,
  skillRef?: ArtifactRef,
  overrides?: Partial<
    Pick<
      ResolvedApp,
      "firstParty" | "source" | "rootPath" | "includeSource" | "hideInLauncher" | "installedAt"
    >
  >,
): ResolvedApp {
  return {
    appId,
    state: "installed",
    enabled: true,
    firstParty: overrides?.firstParty ?? false,
    includeSource: overrides?.includeSource,
    hideInLauncher: overrides?.hideInLauncher,
    source: overrides?.source ?? { mode: "bundle", path: "/tmp/unused" },
    installedHash: "0".repeat(64),
    installedVersion: "0.0.1",
    installedAt: overrides?.installedAt,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    manifest: {
      id: appId,
      version: "0.0.1",
      description: "Test app",
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: overrides?.rootPath ?? "/tmp/unused",
    resolveRoot: "/tmp/unused",
    displayName: "Test App",
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: [], skill: skillRef ? [skillRef] : [], hook: [] },
    web: null,
    api: null,
    db: null,
  };
}

// Bare view for an installed-but-disabled app: no manifest/artifacts, but the
// catalog decorates it with display metadata (see AppCatalog.refreshInternal).
function buildDisabledAppView(appId: string, iconAbsolutePath?: string): AppView {
  return {
    appId,
    state: "installed",
    enabled: false,
    firstParty: false,
    source: { mode: "bundle", path: "/tmp/unused" },
    installedHash: "0".repeat(64),
    installedVersion: "0.0.1",
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    displayName: "Test App",
    iconAbsolutePath,
  };
}

function catalogWith(...apps: Array<AppView | ResolvedApp>): AppCatalog {
  return {
    get: (appId: string): AppView | ResolvedApp | null =>
      apps.find((app) => app.appId === appId) ?? null,
    list: () => apps,
    listResolved: () => apps.filter((app) => "manifest" in app),
    listArtifacts: (kind: ArtifactKind) =>
      apps.flatMap((app) => ("artifacts" in app ? app.artifacts[kind] : [])),
    subscribe: () => () => {},
  } as unknown as AppCatalog;
}

// A fake catalog whose `subscribe` records live subscribers so a test can drive
// `emit()` (mirroring the real catalog's fireEvent) and observe teardown via
// `subscriberCount()`.
function eventCatalog() {
  const subscribers = new Set<SubscriberHandler>();
  const catalog = {
    get: () => null,
    list: async () => [],
    listResolved: () => [],
    listArtifacts: () => [],
    subscribe: (handler: SubscriberHandler): Unsubscribe => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
  } as unknown as AppCatalog;
  async function emit(event: CatalogEvent): Promise<void> {
    for (const handler of subscribers) await handler(event);
  }
  return { catalog, emit, subscriberCount: () => subscribers.size };
}

// Minimal SSE frame reader over a Response body: parses `event:`/`data:` frames
// split on the blank-line boundary.
function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next(): Promise<{ event: string; data: string }> {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const frame = { event: "", data: "" };
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) frame.event = line.slice(6).trim();
            else if (line.startsWith("data:")) frame.data += line.slice(5).trim();
          }
          return frame;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("stream ended before a frame arrived");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    cancel: () => reader.cancel(),
  };
}

function guardianCookie(): string {
  return `${COOKIE_NAME}=${createSession("guardian-1")}`;
}

describe("host app route authorization", () => {
  it("rejects anonymous and app-scoped visitors before any lifecycle work, without an edge proxy", async () => {
    const testDb = createTestDb();
    const publish = rs.spyOn(appPublishing, "publishAppBundle");
    try {
      testDb.db
        .insert(settings)
        .values({
          key: "publicAccess",
          value: {
            allowedApps: ["shared-app"],
            cloudEmailAccess: { "shared-app": ["ada@example.com"] },
          },
          updatedAt: new Date(),
        })
        .run();
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(buildResolvedApp("shared-app")),
      };
      const uninstall = rs.spyOn(deps.appManager, "uninstall");
      const setEnabled = rs.spyOn(deps.appManager, "setEnabled");
      const lookup = rs.spyOn(deps.appCatalog, "get");
      const app = new Hono()
        .use("*", sessionActorMiddleware(deps.db), entryStep(["someone@example.com"]))
        .route("/api", appsRoutes(deps))
        .route("/api", appApiDashboardRoutes(deps));
      for (const [headers, status] of [
        [{}, 401],
        [
          { Cookie: `${VISITOR_COOKIE_NAME}=${createVisitorSession("acct-1", "ada@example.com")}` },
          403,
        ],
        [
          {
            "X-Rome-User-Id": "guardian-1",
            "X-Rome-Visitor-Email": "owner@example.com",
            "X-Forwarded-For": "127.0.0.1",
          },
          401,
        ],
        [{ Cookie: `${COOKIE_NAME}=invalid` }, 401],
        [{ Cookie: `${COOKIE_NAME}=${createVisitorSession("acct-1", "ada@example.com")}` }, 401],
      ] as const) {
        for (const [method, path, body] of [
          ["GET", "/api/apps/shared-app", undefined],
          ["HEAD", "/api/apps/shared-app", undefined],
          ["DELETE", "/api/apps/shared-app", { purge: true }],
          ["PATCH", "/api/apps/shared-app", { enabled: false }],
          ["POST", "/api/apps/shared-app/publish", undefined],
          ["GET", "/api/apps/updates", undefined],
        ] as const) {
          const res = await app.request(path, {
            method,
            headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          expect(res.status, `${method} ${path}`).toBe(status);
        }
      }
      expect(uninstall).not.toHaveBeenCalled();
      expect(setEnabled).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      publish.mockRestore();
      testDb.close();
    }
  });

  for (const caller of ["guardian", "dashboard visitor"] as const) {
    it(`allows a ${caller} to read details, enable, uninstall and publish`, async () => {
      const testDb = createTestDb();
      const publish = rs.spyOn(appPublishing, "publishAppBundle").mockResolvedValue({
        status: "ok",
        listing: { id: "shared-app", handle: "owner", slug: "shared-app" },
        version: {
          version: "0.0.1",
          contentHash: "0".repeat(64),
          sizeBytes: 1,
          sourceAvailable: true,
        },
        claimed: false,
      });
      try {
        testDb.db
          .insert(settings)
          .values({
            key: "dashboardAccess",
            value: { cloudEmailAccess: ["owner@example.com"] },
            updatedAt: new Date(),
          })
          .run();
        const deps = {
          ...(await buildTestDeps(testDb.db)),
          appCatalog: catalogWith(buildResolvedApp("shared-app")),
        };
        const uninstall = rs
          .spyOn(deps.appManager, "uninstall")
          .mockResolvedValue({ alreadyAbsent: true, purged: false, diskCleanupError: null });
        const setEnabled = rs.spyOn(deps.appManager, "setEnabled").mockResolvedValue();
        const app = new Hono()
          .use("*", sessionActorMiddleware(deps.db))
          .route("/api", appsRoutes(deps));
        const headers = {
          Cookie:
            caller === "guardian"
              ? guardianCookie()
              : `${VISITOR_COOKIE_NAME}=${createVisitorSession("owner-1", "owner@example.com")}`,
        };
        const detail = await app.request("/api/apps/shared-app", { headers });
        expect(detail.status).toBe(200);
        expect(await detail.json()).toEqual({
          spec: { source: { mode: "bundle", path: "/tmp/unused" }, enabled: true },
          phase: "installed",
        });
        expect(
          (
            await app.request("/api/apps/shared-app", {
              method: "PATCH",
              headers,
              body: JSON.stringify({ enabled: true }),
            })
          ).status,
        ).toBe(200);
        expect(setEnabled).toHaveBeenCalledWith("shared-app", true);
        expect(
          (await app.request("/api/apps/shared-app", { method: "DELETE", headers })).status,
        ).toBe(200);
        expect(uninstall).toHaveBeenCalledWith("shared-app", { purge: false });
        expect(
          (await app.request("/api/apps/shared-app/publish", { method: "POST", headers })).status,
        ).toBe(201);
        expect(publish).toHaveBeenCalledWith("/tmp/unused", "0".repeat(64));
      } finally {
        publish.mockRestore();
        testDb.close();
      }
    });
  }

  it("keeps public icons, manifests and app-owned HTTP handlers reachable", async () => {
    const testDb = createTestDb();
    const root = await mkdtemp(join(tmpdir(), "rome-public-app-"));
    try {
      const icon = join(root, "icon.svg");
      const entry = join(root, "api.mjs");
      await writeFile(icon, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      await writeFile(
        entry,
        `export function createApiHandler() { return { async handle(request) { return Response.json({ caller: request.caller.kind, method: request.method, path: request.path }); } }; }`,
      );
      testDb.db
        .insert(settings)
        .values({
          key: "publicAccess",
          value: { allowedApps: ["shared-app"] },
          updatedAt: new Date(),
        })
        .run();
      const resolved = buildResolvedApp("shared-app");
      resolved.iconAbsolutePath = icon;
      resolved.api = { appId: "shared-app", entryPath: entry, noAuth: false, relayWebhook: null };
      resolved.web = {
        appId: "shared-app",
        version: "0.0.1",
        entry: "index.js",
        styles: [],
        assetVersion: "abc",
        displayName: "Shared app",
        manifestPath: join(root, "web.json"),
        distPath: root,
      };
      const deps = { ...(await buildTestDeps(testDb.db)), appCatalog: catalogWith(resolved) };
      const app = new Hono()
        .route("/api", appsRoutes(deps))
        .route("/api", appApiDashboardRoutes(deps));
      expect((await app.request("/api/apps/shared-app/icon")).status).toBe(200);
      const manifest = await app.request("/api/apps/shared-app/manifest");
      expect(manifest.status).toBe(200);
      expect(
        ((await manifest.json()) as { bootstrap: { caller: { kind: string } } }).bootstrap.caller
          .kind,
      ).toBe("anonymous");
      for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
        for (const path of ["state", "readme", "updates", "events"]) {
          const res = await app.request(`/api/apps/shared-app/${path}`, { method });
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ caller: "anonymous", method, path: [path] });
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      testDb.close();
    }
  });
});

describe("deriveAppProjectPath", () => {
  it("returns a chat-ready relative path for a remembered source workspace", () => {
    expect(
      deriveAppProjectPath(
        { mode: "source", path: "/home/user/.rome/guardian/projects/apps/weather" },
        "/home/user/.rome/guardian/projects",
      ),
    ).toBe("apps/weather");
  });

  it("does not expose bundle, App Store, or out-of-project sources as chat projects", () => {
    const root = "/home/user/.rome/guardian/projects";
    expect(deriveAppProjectPath({ mode: "bundle", path: `${root}/apps/weather` }, root)).toBeNull();
    expect(
      deriveAppProjectPath({ mode: "appstore", listingId: "weather", version: "1.0.0" }, root),
    ).toBeNull();
    expect(
      deriveAppProjectPath({ mode: "source", path: "/home/user/other/weather" }, root),
    ).toBeNull();
  });
});

describe("GET /apps", () => {
  it("trims SKILL.md before parsing app card skill summaries", async () => {
    const testDb = createTestDb();
    const skillRoot = await mkdtemp(join(tmpdir(), "rome-app-skill-"));
    try {
      await mkdir(join(skillRoot, "skills", "with-leading-blank"), { recursive: true });
      const skillPath = join(skillRoot, "skills", "with-leading-blank");
      await writeFile(
        join(skillPath, "SKILL.md"),
        "\n  \n---\nname: tidy_skill\ndescription: Loads after trim.\n---\n# tidy_skill\n",
      );
      const skillRef: ArtifactRef = {
        kind: "skill",
        publicName: "with-leading-blank",
        aliases: [],
        ownerType: "app",
        ownerId: "test-app",
        absolutePath: skillPath,
      };
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(buildResolvedApp("test-app", skillRef)),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apps: Array<{ capabilityDetails: { skills: Array<Record<string, unknown>> } }>;
      };
      expect(body.apps[0].capabilityDetails.skills).toEqual([
        {
          name: "tidy_skill",
          description: "Loads after trim.",
        },
      ]);
    } finally {
      await rm(skillRoot, { recursive: true, force: true });
      testDb.close();
    }
  });

  it("classifies each app's origin: firstParty → builtin, appstore source → appstore, else local", async () => {
    const testDb = createTestDb();
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(
          buildResolvedApp("shipped", undefined, {
            firstParty: true,
            source: { mode: "bundle", path: "/rome/dist/first-party-artifacts/shipped" },
          }),
          buildResolvedApp("store-app", undefined, {
            source: { mode: "appstore", listingId: "store-app", version: "1.0.0" },
          }),
          buildResolvedApp("built-here", undefined, {
            source: { mode: "source", path: "/home/user/.rome/default/projects/apps/built-here" },
          }),
          buildResolvedApp("packed-here", undefined, {
            source: { mode: "bundle", path: "/home/user/artifacts/packed-here" },
          }),
        ),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps");

      expect(res.status).toBe(200);
      const body = (await res.json()) as { apps: Array<{ id: string; origin: string }> };
      const originById = Object.fromEntries(body.apps.map((card) => [card.id, card.origin]));
      expect(originById).toEqual({
        shipped: "builtin",
        "store-app": "appstore",
        "built-here": "local",
        "packed-here": "local",
      });
    } finally {
      testDb.close();
    }
  });

  it("projects includeSource from the local installed manifest onto the app card", async () => {
    const testDb = createTestDb();
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(
          buildResolvedApp("remixable", undefined, {
            source: { mode: "appstore", listingId: "@alice/remixable", version: "1.2.3" },
            includeSource: true,
          }),
          buildResolvedApp("runtime-only", undefined, {
            source: { mode: "appstore", listingId: "@alice/runtime-only", version: "1.2.3" },
            includeSource: false,
          }),
        ),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apps: Array<{ id: string; includeSource?: boolean }>;
      };
      expect(Object.fromEntries(body.apps.map((card) => [card.id, card.includeSource]))).toEqual({
        remixable: true,
        "runtime-only": false,
      });
    } finally {
      testDb.close();
    }
  });

  it("projects hideInLauncher from the installed manifest onto the app card", async () => {
    const testDb = createTestDb();
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(
          buildResolvedApp("quiet", undefined, { hideInLauncher: true }),
          buildResolvedApp("listed"),
        ),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apps: Array<{ id: string; hideInLauncher?: boolean }>;
      };
      expect(Object.fromEntries(body.apps.map((card) => [card.id, card.hideInLauncher]))).toEqual({
        quiet: true,
        listed: false,
      });
    } finally {
      testDb.close();
    }
  });

  it("keeps a disabled app's display name and iconUrl on its card", async () => {
    const testDb = createTestDb();
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(buildDisabledAppView("dormant", "/tmp/icons/dormant.png")),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apps: Array<{ id: string; status: string; displayName: string; iconUrl: string | null }>;
      };
      expect(body.apps[0]).toMatchObject({
        id: "dormant",
        status: "disabled",
        displayName: "Test App",
        iconUrl: "/api/apps/dormant/icon",
      });
    } finally {
      testDb.close();
    }
  });

  it("projects installedAt onto the app card, null when the entry predates the field", async () => {
    const testDb = createTestDb();
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(
          buildResolvedApp("fresh", undefined, { installedAt: "2026-09-01T00:00:00.000Z" }),
          buildResolvedApp("legacy"),
        ),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps");

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apps: Array<{ id: string; installedAt: string | null }>;
      };
      expect(Object.fromEntries(body.apps.map((card) => [card.id, card.installedAt]))).toEqual({
        fresh: "2026-09-01T00:00:00.000Z",
        legacy: null,
      });
    } finally {
      testDb.close();
    }
  });
});

describe("GET /apps artifact load failures", () => {
  function appWithArtifacts(appId: string, artifacts: Partial<ResolvedApp["artifacts"]>) {
    const app = buildResolvedApp(appId);
    return { ...app, artifacts: { ...app.artifacts, ...artifacts } };
  }

  async function listCapabilityDetails(
    deps: Parameters<typeof appsRoutes>[0],
  ): Promise<Record<string, Record<string, Array<{ name: string; loadError?: string }>>>> {
    const res = await new Hono().route("/", appsRoutes(deps)).request("/apps");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apps: Array<{
        id: string;
        capabilityDetails: Record<string, Array<{ name: string; loadError?: string }>>;
      }>;
    };
    return Object.fromEntries(body.apps.map((card) => [card.id, card.capabilityDetails]));
  }

  it("flags an app agent the agent loader rejected", async () => {
    const testDb = createTestDb();
    const root = await mkdtemp(join(tmpdir(), "rome-app-agent-"));
    try {
      const agentPath = join(root, "reporter.yaml");
      // Parses as YAML and carries a description, so a raw-file read looks
      // healthy, but the portable output-schema check rejects it.
      await writeFile(
        agentPath,
        [
          "name: reporter",
          "description: Writes the weekly report.",
          "systemPromptPrefix: Write the report.",
          "tools: []",
          "permissionMode: default",
          "outputSchema:",
          "  type: object",
          "  properties:",
          "    summary:",
          "      type: string",
          "  required: [summary]",
          "",
        ].join("\n"),
      );
      const catalog = catalogWith(
        appWithArtifacts("reports", {
          agent: [
            {
              kind: "agent",
              publicName: "reporter",
              aliases: [],
              ownerType: "app",
              ownerId: "reports",
              absolutePath: agentPath,
              formatVersion: 2,
            },
          ],
        }),
      );
      const agentLoader = new AgentLoader({ legacyBindings: createEmptyLegacyArtifactBindings() });
      await agentLoader.loadFromCatalog(catalog);

      const details = await listCapabilityDetails({
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalog,
        agentLoader,
      });

      expect(details.reports.agents).toEqual([
        {
          name: "reporter",
          description: "Writes the weekly report.",
          loadError: expect.stringMatching(/Invalid agent config[\s\S]*additionalProperties/),
        },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      testDb.close();
    }
  });

  it("flags only the app action the action loader rejected", async () => {
    const testDb = createTestDb();
    const root = await mkdtemp(join(tmpdir(), "rome-app-action-"));
    try {
      const actionConfig = (name: string, extra: string[] = []) =>
        [
          `name: ${name}`,
          "type: custom",
          `description: Runs ${name}.`,
          "complexity: simple",
          "speed: fast",
          "reliability: high",
          "sideEffects: write",
          ...extra,
          "",
        ].join("\n");
      const actionRef = (publicName: string): ArtifactRef => ({
        kind: "action",
        publicName,
        aliases: [],
        ownerType: "app",
        ownerId: "hooks-app",
        absolutePath: join(root, publicName),
        formatVersion: 2,
      });
      await mkdir(join(root, "healthy"), { recursive: true });
      await writeFile(join(root, "healthy", "action.yaml"), actionConfig("healthy"));
      await mkdir(join(root, "gated"), { recursive: true });
      await writeFile(
        join(root, "gated", "action.yaml"),
        actionConfig("gated", ["webhook: true", "requiresApproval: true"]),
      );
      const catalog = catalogWith(
        appWithArtifacts("hooks-app", { action: [actionRef("healthy"), actionRef("gated")] }),
      );
      const actionLoader = new ActionLoader({
        legacyBindings: createEmptyLegacyArtifactBindings(),
      });
      await actionLoader.loadFromCatalog(catalog);

      const details = await listCapabilityDetails({
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalog,
        actionLoader,
      });

      expect(details["hooks-app"].actions).toEqual([
        {
          name: "gated",
          description: "Runs gated.",
          loadError: expect.stringMatching(/webhook actions cannot require approval/),
        },
        { name: "healthy", description: "Runs healthy." },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
      testDb.close();
    }
  });
});

describe("GET /apps/:appId/icon", () => {
  it("serves the icon of a disabled (unresolved) app", async () => {
    const testDb = createTestDb();
    const iconRoot = await mkdtemp(join(tmpdir(), "rome-app-icon-"));
    try {
      const iconPath = join(iconRoot, "icon.svg");
      await writeFile(iconPath, "<svg xmlns='http://www.w3.org/2000/svg'/>", "utf-8");
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(buildDisabledAppView("dormant", iconPath)),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps/dormant/icon");

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    } finally {
      await rm(iconRoot, { recursive: true, force: true });
      testDb.close();
    }
  });
});

describe("GET /app-readmes/:appId", () => {
  it("serves the README.md packed at the bundle root", async () => {
    const testDb = createTestDb();
    const bundleRoot = await mkdtemp(join(tmpdir(), "rome-app-readme-"));
    try {
      await writeFile(join(bundleRoot, "README.md"), "# Weather\n\nForecasts.\n", "utf-8");
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(buildResolvedApp("weather", undefined, { rootPath: bundleRoot })),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/app-readmes/weather");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        appId: "weather",
        readme: "# Weather\n\nForecasts.\n",
      });
    } finally {
      await rm(bundleRoot, { recursive: true, force: true });
      testDb.close();
    }
  });

  it("degrades to null for a bundle without a README and for an unresolved app", async () => {
    const testDb = createTestDb();
    const bundleRoot = await mkdtemp(join(tmpdir(), "rome-app-readme-"));
    try {
      const deps = {
        ...(await buildTestDeps(testDb.db)),
        appCatalog: catalogWith(
          buildResolvedApp("bare", undefined, { rootPath: bundleRoot }),
          buildDisabledAppView("dormant"),
        ),
      };
      const app = new Hono().route("/", appsRoutes(deps));

      expect(await (await app.request("/app-readmes/bare")).json()).toEqual({
        appId: "bare",
        readme: null,
      });
      expect(await (await app.request("/app-readmes/dormant")).json()).toEqual({
        appId: "dormant",
        readme: null,
      });
    } finally {
      await rm(bundleRoot, { recursive: true, force: true });
      testDb.close();
    }
  });

  it("404s for an app that is not installed", async () => {
    const testDb = createTestDb();
    try {
      const deps = { ...(await buildTestDeps(testDb.db)), appCatalog: catalogWith() };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/app-readmes/ghost");

      expect(res.status).toBe(404);
    } finally {
      testDb.close();
    }
  });
});

describe("GET /apps/events", () => {
  it("streams a minimal { appId, change } frame to a guardian when the catalog fires", async () => {
    const testDb = createTestDb();
    try {
      const { catalog, emit, subscriberCount } = eventCatalog();
      const deps = { ...(await buildTestDeps(testDb.db)), appCatalog: catalog };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps/events", {
        headers: { Cookie: guardianCookie() },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const sse = sseReader(res);
      // The handler subscribes asynchronously once the stream callback runs.
      await rs.waitFor(() => expect(subscriberCount()).toBe(1));

      // Fire a change whose `current` carries full resolved manifest/asset data
      // to prove none of it reaches the wire — only { appId, change } does.
      await emit({ appId: "weather", change: "changed", current: buildResolvedApp("weather") });

      const frame = await sse.next();
      expect(frame.event).toBe("catalog-change");
      expect(JSON.parse(frame.data)).toEqual({ appId: "weather", change: "changed" });

      await sse.cancel();
    } finally {
      testDb.close();
    }
  });

  it("tears down the subscription when the client disconnects", async () => {
    const testDb = createTestDb();
    try {
      const { catalog, subscriberCount } = eventCatalog();
      const deps = { ...(await buildTestDeps(testDb.db)), appCatalog: catalog };
      const app = new Hono().route("/", appsRoutes(deps));

      const res = await app.request("/apps/events", {
        headers: { Cookie: guardianCookie() },
      });
      const sse = sseReader(res);
      await rs.waitFor(() => expect(subscriberCount()).toBe(1));

      await sse.cancel();

      await rs.waitFor(() => expect(subscriberCount()).toBe(0));
    } finally {
      testDb.close();
    }
  });
});
