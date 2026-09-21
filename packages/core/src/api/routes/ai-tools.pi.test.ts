import { describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { createTestDb, buildTestDeps } from "../../test/helpers.js";
import type { PiSettingsService } from "../../lib/pi-provider.js";
import { aiToolsRoutes } from "./ai-tools.js";

const emptyStatus = {
  providers: [],
  models: [],
  catalogStatus: "no-models" as const,
  liveValidity: "not-verified" as const,
  discoveryFailedProviders: [],
};

describe("Pi AI tools routes", () => {
  it("keeps generic test dependencies isolated from Pi user files", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const app = new Hono().route("/", aiToolsRoutes(deps));
      expect((await app.request("/ai-tools/pi")).status).toBe(200);
    } finally {
      testDb.close();
    }
  });

  it("does not probe Pi from generic status and only probes the explicit flow", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const status = rs.fn(async () => emptyStatus);
      const service = { status } as unknown as PiSettingsService;
      const app = new Hono().route("/", aiToolsRoutes({ ...deps, piSettings: service }));
      expect((await app.request("/ai-tools/status")).status).toBe(200);
      expect(status).not.toHaveBeenCalled();
      expect((await app.request("/ai-tools/pi")).status).toBe(200);
      expect(status).toHaveBeenCalledTimes(1);
    } finally {
      testDb.close();
    }
  });

  it("enforces origin and JSON before passing a token to the service", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const saveCredential = rs.fn(async () => ({
        credentialPersisted: true,
        synchronizationSucceeded: true,
        status: emptyStatus,
      }));
      const service = { saveCredential } as unknown as PiSettingsService;
      const app = new Hono().route("/", aiToolsRoutes({ ...deps, piSettings: service }));
      const body = JSON.stringify({ providerId: "kimi-coding", token: "never-return-this" });
      expect((await app.request("/ai-tools/pi/credential", { method: "PUT", body })).status).toBe(
        403,
      );
      expect(
        (
          await app.request("/ai-tools/pi/credential", {
            method: "PUT",
            headers: { "sec-fetch-site": "same-origin" },
            body,
          })
        ).status,
      ).toBe(415);
      const response = await app.request("/ai-tools/pi/credential", {
        method: "PUT",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).not.toContain("never-return-this");
      expect(saveCredential).toHaveBeenCalledWith({
        providerId: "kimi-coding",
        token: "never-return-this",
        confirmReplace: false,
      });
    } finally {
      testDb.close();
    }
  });

  it("sanitizes unexpected service failures", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const service = {
        status: async () => {
          throw new Error("upstream included a secret");
        },
      } as unknown as PiSettingsService;
      const app = new Hono().route("/", aiToolsRoutes({ ...deps, piSettings: service }));
      const response = await app.request("/ai-tools/pi");
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("upstream included a secret");
    } finally {
      testDb.close();
    }
  });
});
