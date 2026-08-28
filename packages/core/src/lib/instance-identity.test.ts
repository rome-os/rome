import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { createFetchRecorder } from "../test/kit/index.js";
import {
  getInstanceToken,
  hydrateInstanceToken,
  proveIdentity,
  seedInstanceTokenFromEnv,
  setInstanceTokenInMemory,
} from "./instance-identity.js";

const TOKEN = "romeinst_abc123def456";
const WHOAMI_URL = "https://rome-cloud.example/api/instance/whoami";

// An in-memory stand-in for SettingsRepository's get/set surface.
function memoryStore(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    async get<T = unknown>(key: string): Promise<T | null> {
      return (data.get(key) as T) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      data.set(key, value);
    },
    async delete(key: string): Promise<void> {
      data.delete(key);
    },
  };
}

describe("getInstanceToken", () => {
  afterEach(() => {
    setInstanceTokenInMemory(null);
  });

  it("returns the token when it has the instance prefix", () => {
    setInstanceTokenInMemory(TOKEN);
    expect(getInstanceToken()).toBe(TOKEN);
  });

  it("returns null when the cache is empty", () => {
    expect(getInstanceToken()).toBeNull();
  });

  it("returns null for a non-instance token (e.g. an account rome_ token)", () => {
    setInstanceTokenInMemory("rome_accounttoken");
    expect(getInstanceToken()).toBeNull();
  });
});

describe("hydrateInstanceToken / seedInstanceTokenFromEnv", () => {
  afterEach(() => {
    setInstanceTokenInMemory(null);
    delete process.env.ROME_INSTANCE_TOKEN;
    delete process.env.ROME_DEV_SKIP_TOKEN_SEED;
  });

  it("hydrates the cache from the DB setting", async () => {
    await hydrateInstanceToken(memoryStore({ instanceToken: TOKEN }));
    expect(getInstanceToken()).toBe(TOKEN);
  });

  it("seeds a valid env token into the store (cloud path)", async () => {
    process.env.ROME_INSTANCE_TOKEN = TOKEN;
    const store = memoryStore();
    expect(await seedInstanceTokenFromEnv(store)).toBe(true);
    expect(store.data.get("instanceToken")).toBe(TOKEN);
  });

  it("ignores a missing or malformed env token", async () => {
    const store = memoryStore();
    expect(await seedInstanceTokenFromEnv(store)).toBe(false);
    process.env.ROME_INSTANCE_TOKEN = "rome_accounttoken";
    expect(await seedInstanceTokenFromEnv(store)).toBe(false);
    expect(store.data.has("instanceToken")).toBe(false);
  });

  it("skips seeding under ROME_DEV_SKIP_TOKEN_SEED even with a valid env token", async () => {
    // Dev forces the box to boot un-enrolled so the browser consent → enroll
    // round trip runs; getInstanceToken() then stays null and the SPA routes to
    // /connect.
    process.env.ROME_INSTANCE_TOKEN = TOKEN;
    process.env.ROME_DEV_SKIP_TOKEN_SEED = "1";
    const store = memoryStore();
    expect(await seedInstanceTokenFromEnv(store)).toBe(false);
    expect(store.data.has("instanceToken")).toBe(false);
    await hydrateInstanceToken(store);
    expect(getInstanceToken()).toBeNull();
  });
});

describe("proveIdentity", () => {
  beforeEach(() => {
    setInstanceTokenInMemory(TOKEN);
    // The fetch origin derives purely from PANTHEON_BASE_ORIGIN (plus the docker
    // loopback fixup), so pinning it here pins what proveIdentity contacts.
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
  });

  afterEach(() => {
    setInstanceTokenInMemory(null);
    delete process.env.PANTHEON_BASE_ORIGIN;
    delete process.env.PANTHEON_DOMAIN;
  });

  it("reports no_token without contacting Rome Cloud when the instance is not enrolled", async () => {
    setInstanceTokenInMemory(null);
    const http = createFetchRecorder();
    expect(await proveIdentity({ fetch: http.fetch })).toEqual({ status: "no_token" });
    expect(http.calls).toHaveLength(0);
  });

  it("reports unconfigured without contacting Rome Cloud when no origin is set", async () => {
    delete process.env.PANTHEON_BASE_ORIGIN;
    const http = createFetchRecorder();
    expect(await proveIdentity({ fetch: http.fetch })).toEqual({ status: "unconfigured" });
    expect(http.calls).toHaveLength(0);
  });

  it("presents the token as a Bearer to /api/instance/whoami and returns the identity", async () => {
    const http = createFetchRecorder();
    http
      .when("GET", WHOAMI_URL)
      .reply(200, { instanceId: "inst-123", account: { id: "acct-789" } });

    expect(await proveIdentity({ fetch: http.fetch })).toEqual({
      status: "ok",
      identity: { accountId: "acct-789", instanceId: "inst-123" },
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("reports the running version on the boot-time identity announcement", async () => {
    const http = createFetchRecorder();
    http
      .when("POST", WHOAMI_URL)
      .reply(200, { instanceId: "inst-123", account: { id: "acct-789" } });

    await expect(proveIdentity({ fetch: http.fetch, bootVersion: "1.2.3" })).resolves.toEqual({
      status: "ok",
      identity: { accountId: "acct-789", instanceId: "inst-123" },
    });
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(http.calls[0].body ?? "null")).toEqual({ version: "1.2.3" });
  });

  it("still announces a source boot when no release version is available", async () => {
    const http = createFetchRecorder();
    http
      .when("POST", WHOAMI_URL)
      .reply(200, { instanceId: "inst-123", account: { id: "acct-789" } });

    await proveIdentity({ fetch: http.fetch, bootVersion: null });

    expect(JSON.parse(http.calls[0].body ?? "null")).toEqual({ version: null });
  });

  it("surfaces the account owner email when whoami returns it (guardian seed)", async () => {
    const http = createFetchRecorder();
    http.when("GET", WHOAMI_URL).reply(200, {
      instanceId: "inst-123",
      account: { id: "acct-789", email: "owner@example.com" },
    });

    expect(await proveIdentity({ fetch: http.fetch })).toEqual({
      status: "ok",
      identity: { accountId: "acct-789", instanceId: "inst-123", email: "owner@example.com" },
    });
  });

  it("surfaces the account owner avatar when whoami returns it", async () => {
    const http = createFetchRecorder();
    http.when("GET", WHOAMI_URL).reply(200, {
      instanceId: "inst-123",
      account: {
        id: "acct-789",
        email: "owner@example.com",
        avatarUrl: "https://example.com/avatar.png",
      },
    });

    expect(await proveIdentity({ fetch: http.fetch })).toEqual({
      status: "ok",
      identity: {
        accountId: "acct-789",
        instanceId: "inst-123",
        email: "owner@example.com",
        avatarUrl: "https://example.com/avatar.png",
      },
    });
  });

  it("maps 401 to unknown (terminal)", async () => {
    const http = createFetchRecorder();
    http.when("GET", WHOAMI_URL).reply(401, { error: "invalid_instance_token" });
    expect(await proveIdentity({ fetch: http.fetch })).toEqual({ status: "unknown" });
  });

  it("maps 403 to revoked (terminal)", async () => {
    const http = createFetchRecorder();
    http.when("GET", WHOAMI_URL).reply(403, { error: "instance_revoked" });
    expect(await proveIdentity({ fetch: http.fetch })).toEqual({ status: "revoked" });
  });

  it("maps a network failure to unreachable (non-terminal)", async () => {
    const http = createFetchRecorder();
    http.when("GET", WHOAMI_URL).failWith(new Error("ECONNREFUSED"));
    expect(await proveIdentity({ fetch: http.fetch })).toEqual({ status: "unreachable" });
    // The scripted failure — not a mismatched URL — is what produced it.
    expect(http.unmatched).toHaveLength(0);
  });

  it("treats a malformed 200 body as unreachable rather than ok", async () => {
    const http = createFetchRecorder();
    http.when("GET", WHOAMI_URL).reply(200, { instanceId: 42 });
    expect(await proveIdentity({ fetch: http.fetch })).toEqual({ status: "unreachable" });
    // "unreachable" also covers any fetch rejection; prove the scripted 200
    // answered, so this pinned the body-validation branch.
    expect(http.calls).toHaveLength(1);
    expect(http.unmatched).toHaveLength(0);
  });
});
