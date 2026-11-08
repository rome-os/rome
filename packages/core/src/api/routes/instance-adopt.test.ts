import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { guardianAuth } from "../../db/schema.js";
import {
  getInstanceToken,
  hydrateInstanceToken,
  type ProveIdentityResult,
  setInstanceTokenInMemory,
} from "../../lib/instance-identity.js";
import { createTestDb, type TestDb } from "../../test/db.js";
import type { ApiDeps } from "../deps.js";
import { instanceAdoptRoutes } from "./instance-adopt.js";

const TOKEN = "romeinst_adopt_token";
const ENV_KEYS = [
  "PANTHEON_DOMAIN",
  "PANTHEON_SLUG",
  "PANTHEON_INSTANCE_ORIGIN",
  "ROME_SIGNER_SOCKET",
] as const;
const POOL_RECORD = { from: "pool-7", to: "acme" };
const savedEnv: Record<string, string | undefined> = {};

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

let testDb: TestDb;
let store: ReturnType<typeof memoryStore>;
let restartWorkers: ReturnType<typeof rs.fn>;
let provisionAfterLink: ReturnType<typeof rs.fn>;

type Persist = NonNullable<Parameters<typeof instanceAdoptRoutes>[1]>["persistInstanceToken"];

// Stands in for the signer-mode persist: stores the token, then reports how
// registering the key went. On success Rome Cloud's whoami names `hostedSlug`
// (left out when it is `undefined`, as for a credential that is not hosted).
function link(
  status: ProveIdentityResult["status"] = "ok",
  // null = Rome Cloud names no hosted slug (`undefined` would take the default).
  hostedSlug: string | null = "acme",
): NonNullable<Persist> {
  return async (settings, token) => {
    await settings.set("instanceToken", token);
    setInstanceTokenInMemory(token);
    return (
      status === "ok"
        ? {
            status,
            identity: {
              accountId: "acct_1",
              instanceId: "inst_1",
              ...(hostedSlug === null ? {} : { hostedSlug }),
            },
          }
        : { status }
    ) as ProveIdentityResult;
  };
}

function mount(seams: Parameters<typeof instanceAdoptRoutes>[1] = {}): Hono {
  const deps = {
    db: testDb.db,
    settingsRepo: store,
    actionEngine: { restartWorkerWarmPool: restartWorkers },
    provisionAfterLink,
  } as unknown as ApiDeps;
  return new Hono().route(
    "/",
    instanceAdoptRoutes(deps, { persistInstanceToken: link(), ...seams }),
  );
}

function adopt(app: Hono, body: unknown) {
  return app.request("/instance/adopt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function insertGuardian(): void {
  testDb.db
    .insert(guardianAuth)
    .values({
      id: "g1",
      userId: "user-1",
      passwordHash: "real-bcrypt-hash",
      accountId: "acct-1",
      onboardingComplete: true,
      createdAt: new Date(),
    })
    .run();
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.PANTHEON_DOMAIN = "romeos.cc";
  process.env.PANTHEON_SLUG = "pool-7";
  process.env.PANTHEON_INSTANCE_ORIGIN = "https://pool-7.romeos.cc";
  process.env.ROME_SIGNER_SOCKET = "/run/signer.sock";
  testDb = createTestDb();
  store = memoryStore();
  restartWorkers = rs.fn(async () => {});
  provisionAfterLink = rs.fn(async () => {});
  await hydrateInstanceToken(memoryStore());
});

afterEach(async () => {
  await hydrateInstanceToken(memoryStore());
  testDb.close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function expectUntouched(): void {
  expect(process.env.PANTHEON_SLUG).toBe("pool-7");
  expect(process.env.PANTHEON_INSTANCE_ORIGIN).toBe("https://pool-7.romeos.cc");
  expect(store.data.has("instanceSlug")).toBe(false);
  expect(restartWorkers).not.toHaveBeenCalled();
  expect(provisionAfterLink).not.toHaveBeenCalled();
}

describe("POST /instance/adopt", () => {
  it("adopts a blank hosted instance: applies the slug, stores it, restarts workers", async () => {
    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: "acme", origin: "https://acme.romeos.cc" });
    expect(process.env.PANTHEON_SLUG).toBe("acme");
    expect(process.env.PANTHEON_INSTANCE_ORIGIN).toBe("https://acme.romeos.cc");
    expect(store.data.get("instanceSlug")).toEqual(POOL_RECORD);
    expect(store.data.get("instanceToken")).toBe(TOKEN);
    expect(getInstanceToken()).toBe(TOKEN);
    expect(restartWorkers).toHaveBeenCalledTimes(1);
    expect(provisionAfterLink).toHaveBeenCalledTimes(1);
  });

  it("does not wait for provisioning", async () => {
    provisionAfterLink = rs.fn(() => new Promise<void>(() => {}));

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(200);
  });

  it("still succeeds when the worker restart fails", async () => {
    restartWorkers = rs.fn(async () => {
      throw new Error("boom");
    });

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(200);
    expect(process.env.PANTHEON_SLUG).toBe("acme");
  });

  it("refuses an instance that is already linked", async () => {
    // In signer mode a registered key is what links the instance.
    await hydrateInstanceToken(memoryStore({ instanceKeyId: "key_existing" }));

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_blank" });
    expectUntouched();
  });

  it("refuses an instance that already has a guardian", async () => {
    insertGuardian();

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_blank" });
    expect(getInstanceToken()).toBeNull();
    expectUntouched();
  });

  it("refuses without a signer, where the token would only be stored", async () => {
    delete process.env.ROME_SIGNER_SOCKET;

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "signer_required" });
    expect(getInstanceToken()).toBeNull();
    expectUntouched();
  });

  it("links first and records {from, to} only afterwards", async () => {
    let recordWhenLinking: unknown = "not read";
    const persist: NonNullable<Persist> = async (settings, token) => {
      recordWhenLinking = store.data.get("instanceSlug");
      return link()(settings, token);
    };

    const res = await adopt(mount({ persistInstanceToken: persist }), { instanceToken: TOKEN });

    expect(res.status).toBe(200);
    expect(recordWhenLinking).toBeUndefined();
    expect(store.data.get("instanceSlug")).toEqual(POOL_RECORD);
  });

  it("ignores a slug in the body: Rome Cloud names it", async () => {
    const res = await adopt(mount(), { slug: "someone-else", instanceToken: TOKEN });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, slug: "acme", origin: "https://acme.romeos.cc" });
    expect(process.env.PANTHEON_SLUG).toBe("acme");
  });

  it("takes whatever slug Rome Cloud names, one character to 63", async () => {
    const long = await adopt(mount({ persistInstanceToken: link("ok", "a".repeat(63)) }), {
      instanceToken: TOKEN,
    });
    expect(long.status).toBe(200);
    expect(process.env.PANTHEON_SLUG).toBe("a".repeat(63));

    await hydrateInstanceToken(memoryStore());
    const short = await adopt(mount({ persistInstanceToken: link("ok", "a") }), {
      instanceToken: TOKEN,
    });
    expect(short.status).toBe(200);
    expect(process.env.PANTHEON_SLUG).toBe("a");
  });

  it.each([
    ["names none (a desktop or browser instance's token)", null],
    ["names a slug that is not a DNS label", "Not A Label"],
    ["names a slug with a dot", "acme.evil.com"],
  ])("refuses and undoes the link when Rome Cloud %s", async (_name, hostedSlug) => {
    const res = await adopt(mount({ persistInstanceToken: link("ok", hostedSlug) }), {
      instanceToken: TOKEN,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_hosted_instance" });
    expect(store.data.has("instanceToken")).toBe(false);
    expect(getInstanceToken()).toBeNull();
    expectUntouched();
  });

  it("undoes the token when linking throws", async () => {
    const persist: NonNullable<Persist> = async (settings, token) => {
      await settings.set("instanceToken", token);
      throw new Error("store unavailable");
    };

    const res = await adopt(mount({ persistInstanceToken: persist }), { instanceToken: TOKEN });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "adopt_failed" });
    expect(store.data.has("instanceToken")).toBe(false);
    expectUntouched();
  });

  it("undoes the token when the slug record cannot be stored", async () => {
    const failingSet = store.set.bind(store);
    store.set = async (key, value) => {
      if (key === "instanceSlug") throw new Error("disk full");
      return failingSet(key, value);
    };

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "adopt_failed" });
    expect(store.data.has("instanceToken")).toBe(false);
    expectUntouched();
  });

  it("refuses an instance that is not hosted", async () => {
    delete process.env.PANTHEON_DOMAIN;

    const res = await adopt(mount(), { instanceToken: TOKEN });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_hosted" });
    expect(getInstanceToken()).toBeNull();
    expectUntouched();
  });

  it.each(["rome_accounttoken", "", 7, null])("rejects the token %j", async (instanceToken) => {
    const res = await adopt(mount(), { instanceToken });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_token" });
    expectUntouched();
  });

  it("rejects a body that is not JSON", async () => {
    const res = await mount().request("/instance/adopt", { method: "POST", body: "nope" });

    expect(res.status).toBe(400);
    expectUntouched();
  });

  describe("link failure", () => {
    it.each([
      "unreachable",
      "signer_unavailable",
      "clock_skew",
      "audience_mismatch",
      "unconfigured",
    ] as const)("answers 502 for the transient status %s and undoes the token", async (status) => {
      const res = await adopt(mount({ persistInstanceToken: link(status) }), {
        instanceToken: TOKEN,
      });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "link_failed", status });
      expect(store.data.has("instanceToken")).toBe(false);
      expect(getInstanceToken()).toBeNull();
      expectUntouched();
    });

    it.each([
      "unknown",
      "revoked",
      "key_conflict",
      "upgrade_required",
    ] as const)("answers 409 for the terminal status %s and undoes the token", async (status) => {
      const res = await adopt(mount({ persistInstanceToken: link(status) }), {
        instanceToken: TOKEN,
      });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "link_failed", status });
      expect(store.data.has("instanceToken")).toBe(false);
      expect(getInstanceToken()).toBeNull();
      expectUntouched();
    });
  });
});
