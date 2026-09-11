import { describe, it, expect, beforeEach, afterEach, rs } from "@rstest/core";
import { Hono } from "hono";
import { settingsRoutes } from "./settings.js";
import { createTestDb, buildTestDeps, type TestDb, type TestDeps } from "../../test/helpers.js";
import { seedBaseline } from "../../test/seeds.js";
import { ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING } from "../../lib/anthropic-compatible-providers.js";
import { GUARDIAN_TIMEZONE_SETTING_KEY } from "../../routines/guardian-timezone.js";

async function putSettings(app: Hono, body: Record<string, unknown>) {
  return app.request("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Settings API", () => {
  let testDb: TestDb;
  let deps: TestDeps;
  let app: Hono;

  beforeEach(async () => {
    testDb = createTestDb();
    deps = await buildTestDeps(testDb.db);
    app = new Hono().route("/", settingsRoutes(deps));
  });

  afterEach(() => testDb.close());

  it("returns an empty object on a fresh DB", async () => {
    const res = await app.request("/settings");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("returns baseline settings after seeding", async () => {
    await seedBaseline(testDb.db);
    const res = await app.request("/settings");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      timezone: "America/Los_Angeles",
      locale: "en-US",
    });
  });

  it("upserts new keys via PUT without clobbering existing ones", async () => {
    await seedBaseline(testDb.db);

    const put = await app.request("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: "dark", sidebarWidth: 240 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });

    const get = await app.request("/settings");
    const body = (await get.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      timezone: "America/Los_Angeles", // baseline preserved
      locale: "en-US",
      theme: "dark",
      sidebarWidth: 240,
    });
  });

  it("merges on repeated PUT calls (overwrites same key, leaves others)", async () => {
    await app.request("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1, b: 2 }),
    });
    await app.request("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ b: 22, c: 3 }),
    });
    const res = await app.request("/settings");
    expect(await res.json()).toEqual({ a: 1, b: 22, c: 3 });
  });

  it("redacts Anthropic-compatible provider API keys from general settings reads", async () => {
    await deps.settingsRepo.set(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING, {
      provider: "deepseek",
      apiKey: "deepseek-key",
      updatedAt: "2026-04-26T00:00:00.000Z",
    });

    const res = await app.request("/settings");
    const body = await res.json();
    expect(body).toMatchObject({
      [ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING]: {
        provider: "deepseek",
        providerName: "DeepSeek",
        hasApiKey: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("deepseek-key");
  });

  it("redacts the entire custom provider environment from general settings reads", async () => {
    await deps.settingsRepo.set(ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING, {
      provider: "custom",
      env: {
        ANTHROPIC_AUTH_TOKEN: "ark-key",
        ANTHROPIC_BASE_URL: "https://ark.example.com/api/plan",
        ANTHROPIC_MODEL: "ep-model",
      },
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    const res = await app.request("/settings");
    const body = await res.json();
    expect(body).toMatchObject({
      [ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING]: {
        provider: "custom",
        providerName: "Custom",
        hasApiKey: true,
      },
    });
    expect(JSON.stringify(body)).not.toContain("ark-key");
    expect(JSON.stringify(body)).not.toContain("ark.example.com");
    expect(JSON.stringify(body)).not.toContain("ep-model");
  });

  // A guardianTimezone change must re-target floating routines.
  describe("guardianTimezone change re-activates floating routines", () => {
    it("re-activates when the timezone value actually changes", async () => {
      const spy = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();
      await deps.settingsRepo.set(GUARDIAN_TIMEZONE_SETTING_KEY, "America/Los_Angeles");

      const res = await putSettings(app, { [GUARDIAN_TIMEZONE_SETTING_KEY]: "Asia/Tokyo" });

      expect(res.status).toBe(200);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBe("Asia/Tokyo");
    });

    it("does not re-activate when the same timezone is re-saved", async () => {
      const spy = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();
      await deps.settingsRepo.set(GUARDIAN_TIMEZONE_SETTING_KEY, "Asia/Tokyo");

      const res = await putSettings(app, { [GUARDIAN_TIMEZONE_SETTING_KEY]: "Asia/Tokyo" });

      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });

    it("does not re-activate when an unrelated setting changes", async () => {
      const spy = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();

      const res = await putSettings(app, { theme: "dark" });

      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });

    it("rejects an invalid guardianTimezone with 400, persisting nothing and not reactivating", async () => {
      const spy = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();

      const res = await putSettings(app, {
        [GUARDIAN_TIMEZONE_SETTING_KEY]: "Pacific Time",
        theme: "dark",
      });

      expect(res.status).toBe(400);
      // The whole write is rejected — neither the bad zone nor the sibling key lands.
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBeNull();
      expect(await deps.settingsRepo.get("theme")).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it("trims and canonicalizes a valid guardianTimezone before persisting", async () => {
      rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();

      const res = await putSettings(app, { [GUARDIAN_TIMEZONE_SETTING_KEY]: "  Asia/Tokyo  " });

      expect(res.status).toBe(200);
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBe("Asia/Tokyo");
    });

    it("clears guardianTimezone on a blank value, deleting the setting and reactivating", async () => {
      const spy = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();
      await deps.settingsRepo.set(GUARDIAN_TIMEZONE_SETTING_KEY, "Asia/Tokyo");

      const res = await putSettings(app, { [GUARDIAN_TIMEZONE_SETTING_KEY]: "" });

      expect(res.status).toBe(200);
      // Cleared back to the host/UTC fallback, and floating routines rescheduled.
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("clearing an already-unset guardianTimezone is a no-op", async () => {
      const spy = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();

      const res = await putSettings(app, { [GUARDIAN_TIMEZONE_SETTING_KEY]: null });

      expect(res.status).toBe(200);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("POST /settings/guardian-timezone/detected", () => {
    async function postDetected(timezone: unknown) {
      return app.request("/settings/guardian-timezone/detected", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone }),
      });
    }

    it("adopts the browser zone when none is stored and reschedules floating routines", async () => {
      const reactivate = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();

      const res = await postDetected("Asia/Tokyo");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "set", tzid: "Asia/Tokyo" });
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBe("Asia/Tokyo");
      expect(reactivate).toHaveBeenCalledOnce();
    });

    it("never overwrites a stored zone", async () => {
      await putSettings(app, { [GUARDIAN_TIMEZONE_SETTING_KEY]: "Europe/Paris" });
      const reactivate = rs.spyOn(deps.routineEngine, "reactivateFloating").mockResolvedValue();

      const res = await postDetected("Asia/Tokyo");

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "unchanged", tzid: "Europe/Paris" });
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBe("Europe/Paris");
      expect(reactivate).not.toHaveBeenCalled();
    });

    it("rejects a value that is not an IANA zone", async () => {
      const res = await postDetected("Mars/Olympus");

      expect(res.status).toBe(400);
      expect(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBeNull();
    });
  });
});
