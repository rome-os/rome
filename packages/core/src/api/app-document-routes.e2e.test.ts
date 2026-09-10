/**
 * Black-box regression: `buildApp` mounts the SPA shell (`mountSpa` in
 * `api/index.ts`) with per-app social meta on `/apps/*` and `/full/apps/*`
 * document routes, swapped via `buildAppSocialCard` +
 * `renderSocialMeta` (`api/app-social-card.ts`, `lib/social-meta.ts`).
 * Everything else — unknown apps, non-app SPA routes, static assets — must
 * keep serving the shell/asset unchanged.
 *
 * The fixture drives the real production `buildApp` against a temp
 * `webRoot` so a future regression in the mount order, the social-meta
 * swap, or the static-vs-fallback precedence breaks this test without it
 * needing to mirror that wiring itself.
 */
import { afterAll, describe, expect, it } from "@rstest/core";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApp } from "./index.js";
import type { ApiConfig, ApiDeps } from "./deps.js";
import type { AppCatalog } from "../apps/catalog.js";
import type { AppView, ResolvedApp } from "../apps/state.js";
import { buildTestDeps, createTestDb } from "../test/helpers.js";

const INDEX_HTML = `<html><head>
<title>Rome</title>
<!-- rome:social:start -->
<meta property="og:title" content="Rome OS - Enjoy your life with Rome" />
<meta property="og:image" content="https://romeos.cc/public-og-20260825.jpg" />
<!-- rome:social:end -->
</head><body></body></html>`;

const webRoot = mkdtempSync(path.join(os.tmpdir(), "rome-app-document-routes-"));
writeFileSync(path.join(webRoot, "index.html"), INDEX_HTML, "utf8");
writeFileSync(path.join(webRoot, "icon.svg"), "<svg></svg>", "utf8");

const testDb = createTestDb();
afterAll(() => {
  testDb.close();
  rmSync(webRoot, { recursive: true, force: true });
});

function buildRedditFixture(): ResolvedApp {
  return {
    appId: "reddit",
    state: "installed",
    enabled: true,
    firstParty: false,
    source: { mode: "bundle", path: "/tmp/unused" },
    installedHash: "0".repeat(64),
    installedVersion: "0.0.1",
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    manifest: {
      id: "reddit",
      version: "0.0.1",
      description: 'Watches <subreddits> & "more"',
      agents: [],
      actions: [],
      skills: [],
      hooks: [],
    },
    rootPath: "/tmp/unused",
    resolveRoot: "/tmp/unused",
    displayName: "Reddit Radar",
    iconAbsolutePath: undefined,
    artifacts: { agent: [], action: [], skill: [], hook: [] },
    web: {
      assetVersion: "abcdef123456",
      distPath: "/tmp/unused",
      entry: "index.js",
      styles: [],
      displayName: "Reddit Radar",
    } as unknown as ResolvedApp["web"],
    api: null,
    db: null,
  };
}

async function buildTestHost() {
  const map = new Map<string, ResolvedApp>([["reddit", buildRedditFixture()]]);
  const catalog = {
    get: (appId: string): AppView | ResolvedApp | null => map.get(appId) ?? null,
    list: () => Array.from(map.values()),
    subscribe: () => () => {},
  } as unknown as AppCatalog;
  const deps: ApiDeps = { ...(await buildTestDeps(testDb.db)), appCatalog: catalog };
  const config: ApiConfig = { port: 0, host: "127.0.0.1", webRoot };
  return buildApp(deps, config).app;
}

const HEADERS = { host: "jessie.romeos.cc", "x-forwarded-proto": "https" };

describe("app document routes through buildApp", () => {
  it("swaps the shell's social meta for a routed app on /full/apps/:id", async () => {
    const app = await buildTestHost();
    const res = await app.request("/full/apps/reddit", { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-cache");
    const body = await res.text();
    expect(body).toContain("<title>Reddit Radar</title>");
    expect(body).toContain('<meta property="og:title" content="Reddit Radar" />');
    expect(body).toContain(
      '<meta property="og:description" content="Watches &lt;subreddits&gt; &amp; &quot;more&quot;" />',
    );
    expect(body).toContain(
      '<meta property="og:url" content="https://jessie.romeos.cc/full/apps/reddit" />',
    );
    expect(body).not.toContain("Rome OS - Enjoy your life with Rome");
  });

  it("swaps meta for embedded /apps/:id sub-paths too", async () => {
    const app = await buildTestHost();
    const res = await app.request("/apps/reddit/posts/1", { headers: HEADERS });
    const body = await res.text();
    expect(body).toContain(
      '<meta property="og:url" content="https://jessie.romeos.cc/apps/reddit/posts/1" />',
    );
  });

  it("keeps the static shell for an unknown app and for non-app SPA routes", async () => {
    const app = await buildTestHost();
    for (const routePath of ["/full/apps/nope", "/dashboard"]) {
      const res = await app.request(routePath, { headers: HEADERS });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain("<title>Rome</title>");
      expect(body).toContain(
        '<meta property="og:title" content="Rome OS - Enjoy your life with Rome" />',
      );
    }
  });

  it("still serves static assets ahead of the SPA fallback", async () => {
    const app = await buildTestHost();
    const res = await app.request("/icon.svg", { headers: HEADERS });
    expect(res.status).toBe(200);
  });
});
