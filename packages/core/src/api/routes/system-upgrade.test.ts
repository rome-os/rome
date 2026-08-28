import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";

// The routes read the build identity through getBuildInfo(), which caches at
// module scope — each case re-imports the route module fresh after setting the
// env it should observe.
// The instance token now lives in an in-memory cache, not the env. Each fresh
// import re-evaluates instance-identity (rs.resetModules), so set the cache on
// the *same* fresh module the route imports — hence the import lives here, after
// the reset, rather than at the top of the file.
async function freshApp(opts: { enrolled?: boolean } = {}) {
  rs.resetModules();
  const { setInstanceTokenInMemory } = await import("../../lib/instance-identity.js");
  setInstanceTokenInMemory(opts.enrolled === false ? null : "romeinst_test-token");
  const { systemUpgradeRoutes } = await import("./system-upgrade.js");
  const { SystemUpgradeService } = await import("../../system-upgrade/service.js");
  // The countdown verbs drive the service's real hub; the manual relay verbs
  // (/check, POST /upgrade) leave it idle. Both talk to Rome Cloud through the
  // stubbed global fetch.
  const service = new SystemUpgradeService({ countdownMs: 600_000 });
  const app = new Hono().route("/", systemUpgradeRoutes({ systemUpgradeService: service }));
  return { app, service };
}

const ENV_KEYS = [
  "PANTHEON_BASE_ORIGIN",
  "PANTHEON_DOMAIN",
  "ROME_VERSION",
  "ROME_BUILD_SHA",
  "ROME_BUILD_TIME",
] as const;

type RecordedRequest = { url: string; method: string; headers: Headers; body: string | null };

/** Stub Rome Cloud at the network seam: every outbound fetch gets `response`. */
function stubRomeCloud(response: { status: number; json?: unknown; text?: string }) {
  const requests: RecordedRequest[] = [];
  rs.stubGlobal(
    "fetch",
    rs.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : null,
      });
      const body = response.text ?? JSON.stringify(response.json);
      return new Response(body, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return requests;
}

function stubRomeCloudDown() {
  rs.stubGlobal(
    "fetch",
    rs.fn(async () => {
      throw new TypeError("fetch failed");
    }),
  );
}

describe("system upgrade API", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.test";
    // Both verbs self-reject on an unversioned build, so the default fixture
    // is a versioned release image; the unversioned cases unset this.
    process.env.ROME_VERSION = "1.1.0";
  });

  afterEach(() => {
    rs.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("GET /system/upgrade/status/snapshot", () => {
    it("returns the current status without opening a stream", async () => {
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/status/snapshot");

      expect(res.status).toBe(200);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.json()).toEqual({
        phase: "idle",
        targetVersion: null,
        deadline: null,
        serverNow: expect.any(Number),
      });
    });
  });

  describe("POST /system/upgrade/now", () => {
    it("acks with an updating snapshot once Rome Cloud accepts the cutover", async () => {
      stubRomeCloud({ status: 202, json: { status: "upgrading", target: "1.2.0" } });
      const { app, service } = await freshApp();
      service.getHub().beginCountdown("1.2.0", 600_000);

      const res = await app.request("/system/upgrade/now", { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ phase: "updating", targetVersion: "1.2.0" });
    });

    it("surfaces a failed relay and leaves the countdown standing", async () => {
      stubRomeCloudDown();
      const { app, service } = await freshApp();
      service.getHub().beginCountdown("1.2.0", 600_000);

      const res = await app.request("/system/upgrade/now", { method: "POST" });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "pantheon_unreachable" });
      expect(service.getHub().getSnapshot().phase).toBe("countdown");
    });

    it("is an idempotent no-op outside a countdown", async () => {
      const requests = stubRomeCloud({ status: 202, json: {} });
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/now", { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ phase: "idle" });
      expect(requests).toHaveLength(0);
    });
  });

  describe("POST /system/upgrade/defer", () => {
    it("tears the countdown down and reports the reverted phase", async () => {
      const requests = stubRomeCloud({ status: 202, json: {} });
      const { app, service } = await freshApp();
      service.getHub().beginCountdown("1.2.0", 600_000);

      const res = await app.request("/system/upgrade/defer", { method: "POST" });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ phase: "idle", targetVersion: null });
      expect(requests).toHaveLength(0);
    });
  });

  describe("GET /system/upgrade/check", () => {
    it("returns 503 pantheon_unconfigured when the instance token is missing", async () => {
      const { app } = await freshApp({ enrolled: false });

      const res = await app.request("/system/upgrade/check");

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "pantheon_unconfigured" });
    });

    it("returns 503 pantheon_unconfigured when no Rome Cloud origin is configured", async () => {
      delete process.env.PANTHEON_BASE_ORIGIN;
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/check");

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "pantheon_unconfigured" });
    });

    it("forwards local version+sha to Rome Cloud and mirrors the 200 check response", async () => {
      process.env.ROME_VERSION = "1.1.0";
      process.env.ROME_BUILD_SHA = "abc1234";
      const checkBody = {
        current: { version: "1.1.0", sha: "abc1234" },
        latest: { version: "1.2.0" },
        upgradeAvailable: true,
      };
      const requests = stubRomeCloud({ status: 200, json: checkBody });
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/check");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(checkBody);
      expect(requests).toHaveLength(1);
      const sent = new URL(requests[0].url);
      expect(sent.origin).toBe("https://rome-cloud.test");
      expect(sent.pathname).toBe("/api/instance/upgrade/check");
      expect(sent.searchParams.get("version")).toBe("1.1.0");
      expect(sent.searchParams.get("sha")).toBe("abc1234");
      expect(requests[0].headers.get("Authorization")).toBe("Bearer romeinst_test-token");
    });

    it("rejects an unversioned build before contacting Rome Cloud", async () => {
      delete process.env.ROME_VERSION;
      const requests = stubRomeCloud({ status: 200, json: {} });
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/check");

      // A build with no release identity can't be compared against latest —
      // Rome Cloud would report an upgrade available forever.
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unversioned_build" });
      expect(requests).toHaveLength(0);
    });

    it("mirrors Rome Cloud's 503 latest_unresolvable instead of reporting up-to-date", async () => {
      stubRomeCloud({ status: 503, json: { error: "latest_unresolvable" } });
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/check");

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "latest_unresolvable" });
    });

    it("returns 502 pantheon_unreachable when the network call fails", async () => {
      stubRomeCloudDown();
      const { app } = await freshApp();

      const res = await app.request("/system/upgrade/check");

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "pantheon_unreachable" });
    });
  });

  describe("POST /system/upgrade", () => {
    function postUpgrade(app: Hono, body: unknown) {
      return app.request("/system/upgrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("rejects an unversioned build before contacting Rome Cloud", async () => {
      delete process.env.ROME_VERSION;
      const requests = stubRomeCloud({ status: 202, json: {} });
      const { app } = await freshApp();

      const res = await postUpgrade(app, { target: "1.2.0" });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "unversioned_build" });
      expect(requests).toHaveLength(0);
    });

    it("rejects a request without a target before contacting Rome Cloud", async () => {
      const requests = stubRomeCloud({ status: 202, json: {} });
      const { app } = await freshApp();

      const res = await postUpgrade(app, {});

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "target_required" });
      expect(requests).toHaveLength(0);
    });

    it("returns 503 pantheon_unconfigured when the instance token is missing", async () => {
      const { app } = await freshApp({ enrolled: false });

      const res = await postUpgrade(app, { target: "1.2.0" });

      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "pantheon_unconfigured" });
    });

    it("forwards the pinned target and mirrors Rome Cloud's 202 upgrading response", async () => {
      const requests = stubRomeCloud({
        status: 202,
        json: { status: "upgrading", target: "1.2.0" },
      });
      const { app } = await freshApp();

      const res = await postUpgrade(app, { target: "1.2.0" });

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: "upgrading", target: "1.2.0" });
      expect(requests).toHaveLength(1);
      expect(new URL(requests[0].url).pathname).toBe("/api/instance/upgrade");
      expect(requests[0].method).toBe("POST");
      expect(requests[0].body).toBe(JSON.stringify({ target: "1.2.0" }));
      expect(requests[0].headers.get("Authorization")).toBe("Bearer romeinst_test-token");
    });

    it("mirrors Rome Cloud's 409 target_not_latest so the dashboard can re-confirm", async () => {
      stubRomeCloud({ status: 409, json: { error: "target_not_latest", latest: "1.3.0" } });
      const { app } = await freshApp();

      const res = await postUpgrade(app, { target: "1.2.0" });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "target_not_latest", latest: "1.3.0" });
    });

    it("returns 502 pantheon_unreachable when the network call fails", async () => {
      stubRomeCloudDown();
      const { app } = await freshApp();

      const res = await postUpgrade(app, { target: "1.2.0" });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "pantheon_unreachable" });
    });
  });
});
