import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { publicAccessRoutes } from "./public-access.js";
import { PublicAccessState } from "../../lib/public-access-state.js";
import { createTestDb, buildTestDeps, type TestDb } from "../../test/helpers.js";
import type { ApiDeps } from "../deps.js";
import * as gatewayPageModule from "../../lib/gateway-page.js" with { rstest: "importActual" };

// Public-access routes over the real lib/public-access pipeline (edge-only
// fakes, #763): PUT runs the production writeCaddyfileAndReload — the
// Caddyfile lands on disk at CADDY_CONFIG_PATH and `caddy reload` forks for
// real. The only fake is the `caddy` binary itself: a PATH-injected script
// that records its argv (the outbound contract at the subprocess edge) and
// can be told to fail.
//
// generateGatewayPage is the one internal stub: it writes to the hardcoded
// privileged path /etc/caddy/static/gateway.html, which no env var or
// parameter can redirect into the temp sandbox — on a root runner the write
// would succeed and escape the test. Stubbed to a no-op until the output
// path grows a seam (Track B note on #763). getInstanceName stays real.

rs.mock("../../lib/gateway-page.js", () => ({
  ...gatewayPageModule,
  generateGatewayPage: rs.fn(async () => {}),
}));

const ENV_KEYS = [
  "CADDY_CONFIG_PATH",
  "PATH",
  "PANTHEON_SLUG",
  "CADDY_SPY_FILE",
  "CADDY_FAKE_FAIL",
] as const;

describe("Public-access API", () => {
  let testDb: TestDb;
  let app: Hono;
  let deps: ApiDeps;
  let publicAccessState: PublicAccessState;
  let sandboxDir: string;
  let caddyPath: string;
  let spyFile: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    sandboxDir = mkdtempSync(join(tmpdir(), "rome-public-access-"));
    caddyPath = join(sandboxDir, "Caddyfile");
    spyFile = join(sandboxDir, "caddy-reload-args");

    const binDir = join(sandboxDir, "bin");
    mkdirSync(binDir);
    const fakeCaddy = join(binDir, "caddy");
    writeFileSync(
      fakeCaddy,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$CADDY_SPY_FILE"\nif [ -n "$CADDY_FAKE_FAIL" ]; then\n  echo "caddy: reload failed" >&2\n  exit 1\nfi\n`,
    );
    chmodSync(fakeCaddy, 0o755);

    process.env.CADDY_CONFIG_PATH = caddyPath;
    process.env.CADDY_SPY_FILE = spyFile;
    process.env.PATH = `${binDir}:${process.env.PATH}`;
    // getInstanceName falls back to `tailscale status` when neither a guardian
    // person nor PANTHEON_SLUG exists — pin the slug so no real binary runs.
    process.env.PANTHEON_SLUG = "test-instance";
    delete process.env.CADDY_FAKE_FAIL;

    testDb = createTestDb();
    publicAccessState = new PublicAccessState();
    deps = { ...(await buildTestDeps(testDb.db)), publicAccessState };
    app = new Hono().route("/", publicAccessRoutes(deps));
  });

  afterEach(() => {
    testDb.close();
    rmSync(sandboxDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  const reloadArgs = (): string[] | null =>
    existsSync(spyFile) ? readFileSync(spyFile, "utf-8").trim().split("\n") : null;

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
        enableAccessControl: false,
        allowedApps: [],
        cloudEmailAccess: {},
      });
    });

    it("returns the normalized config when a row exists", async () => {
      await deps.settingsRepo!.set("publicAccess", {
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
        enableAccessControl: boolean;
        allowedApps: string[];
        cloudEmailAccess: Record<string, string[]>;
      };
      expect(body.enableAccessControl).toBe(true);
      expect(body.allowedApps.sort()).toEqual(["inbox", "news"]);
      expect(body.cloudEmailAccess).toEqual({ inbox: ["a@example.com"] });
    });
  });

  describe("PUT /public-access", () => {
    it("persists the normalized config, writes the Caddyfile, and reloads caddy", async () => {
      const res = await putConfig(
        JSON.stringify({
          enableAccessControl: true,
          allowedApps: ["inbox", "not a slug"],
          cloudEmailAccess: { inbox: ["Ada@Example.com"] },
        }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });

      // The config survives a round-trip through the DB, normalized.
      const getRes = await app.request("/public-access");
      expect(await getRes.json()).toEqual({
        enableAccessControl: true,
        allowedApps: ["inbox"],
        cloudEmailAccess: { inbox: ["ada@example.com"] },
      });

      // The Caddyfile on disk reflects the normalized config: per-app routes
      // for the valid slug only, gateway fallback instead of forward_auth.
      const caddyfile = readFileSync(caddyPath, "utf-8");
      expect(caddyfile).toContain("handle /apps/inbox {");
      expect(caddyfile).not.toContain("not a slug");
      expect(caddyfile).toContain("rewrite * /gateway.html");
      expect(caddyfile).not.toContain("forward_auth");

      expect(reloadArgs()).toEqual(["reload", "--config", caddyPath]);
    });

    it("refreshes the auth-edge allowed-apps snapshot", async () => {
      const res = await putConfig(
        JSON.stringify({
          enableAccessControl: true,
          allowedApps: ["inbox", "news"],
        }),
      );
      expect(res.status).toBe(200);
      expect([...publicAccessState.allowedApps()].sort()).toEqual(["inbox", "news"]);
    });

    it("accepts an empty body (null → defaults)", async () => {
      const res = await putConfig("not-json");
      expect(res.status).toBe(200);

      const caddyfile = readFileSync(caddyPath, "utf-8");
      expect(caddyfile).toContain("forward_auth");
      expect(caddyfile).not.toContain("gateway.html");
      expect(reloadArgs()).toEqual(["reload", "--config", caddyPath]);
    });

    it("returns 500 with the caddy error detail when the reload fails, after persisting the config", async () => {
      process.env.CADDY_FAKE_FAIL = "1";
      const res = await putConfig(
        JSON.stringify({ enableAccessControl: true, allowedApps: ["inbox"] }),
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { ok: boolean; detail: string };
      expect(body.ok).toBe(false);
      expect(body.detail).toContain("caddy");

      // The DB write and auth-edge snapshot happen before the reload, so a
      // failed reload must not roll them back — verify stays consistent with
      // what's persisted.
      const getRes = await app.request("/public-access");
      expect(await getRes.json()).toEqual({
        enableAccessControl: true,
        allowedApps: ["inbox"],
        cloudEmailAccess: {},
      });
      expect([...publicAccessState.allowedApps()]).toEqual(["inbox"]);
    });
  });
});
