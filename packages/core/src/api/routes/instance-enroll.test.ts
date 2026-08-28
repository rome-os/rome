import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Hono } from "hono";
import { instanceEnrollRoutes } from "./instance-enroll.js";
import { getInstanceToken, setInstanceTokenInMemory } from "../../lib/instance-identity.js";
import type { ApiDeps } from "../deps.js";

const TOKEN = "romeinst_test_token";
const ENV_KEYS = ["PANTHEON_BASE_ORIGIN", "PANTHEON_DOMAIN", "PANTHEON_INSTANCE_ORIGIN"] as const;
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

function depsWithStore(
  store: ReturnType<typeof memoryStore>,
  overrides: Partial<ApiDeps> = {},
): ApiDeps {
  return {
    settingsRepo: store,
    relayDrainer: { reload: async () => {} },
    ...overrides,
  } as unknown as ApiDeps;
}

function mount(deps: ApiDeps, seams: Parameters<typeof instanceEnrollRoutes>[1] = {}): Hono {
  return new Hono().route("/", instanceEnrollRoutes(deps, seams));
}

describe("POST /instance/enroll/start", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
    process.env.PANTHEON_INSTANCE_ORIGIN = "http://main.rome.localhost:3000";
    delete process.env.PANTHEON_DOMAIN;
    setInstanceTokenInMemory(null);
  });

  afterEach(() => {
    setInstanceTokenInMemory(null);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it.each([
    "revoked",
    "unknown",
  ] as const)("clears a %s local token and starts fresh enrollment", async (status) => {
    setInstanceTokenInMemory(TOKEN);
    const store = memoryStore({
      instanceToken: TOKEN,
      relay: {
        drainUrl: "wss://relay.example/c/mailbox",
        drainKey: "secret",
        depositUrl: "https://relay.example/h/mailbox",
      },
    });
    let reloadArg: unknown = null;
    const relayDrainer = {
      reload: async (drains: unknown) => {
        reloadArg = drains;
      },
    };
    const app = mount(depsWithStore(store, { relayDrainer } as unknown as Partial<ApiDeps>), {
      proveIdentity: async () => ({ status }),
    });

    const res = await app.request("/instance/enroll/start", { method: "POST" });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authorizeUrl?: string };
    expect(body.authorizeUrl).toMatch(/^https:\/\/rome-cloud\.example\/instance\/authorize\?/);
    const url = new URL(body.authorizeUrl ?? "");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://main.rome.localhost:3000/api/instance/enroll/callback",
    );
    expect(store.data.has("instanceToken")).toBe(false);
    expect(store.data.has("relay")).toBe(false);
    expect(reloadArg).toEqual([]);
    expect(getInstanceToken()).toBeNull();
  });

  it("keeps rejecting an already valid enrollment", async () => {
    setInstanceTokenInMemory(TOKEN);
    const store = memoryStore({ instanceToken: TOKEN });
    const app = mount(depsWithStore(store), {
      proveIdentity: async () => ({
        status: "ok",
        identity: { accountId: "acct_1", instanceId: "inst_1" },
      }),
    });

    const res = await app.request("/instance/enroll/start", { method: "POST" });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "already_enrolled" });
    expect(store.data.get("instanceToken")).toBe(TOKEN);
    expect(getInstanceToken()).toBe(TOKEN);
  });

  it("does not clear the token when Rome Cloud is unreachable", async () => {
    setInstanceTokenInMemory(TOKEN);
    const store = memoryStore({ instanceToken: TOKEN });
    const app = mount(depsWithStore(store), {
      proveIdentity: async () => ({ status: "unreachable" }),
    });

    const res = await app.request("/instance/enroll/start", { method: "POST" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "identity_unreachable" });
    expect(store.data.get("instanceToken")).toBe(TOKEN);
    expect(getInstanceToken()).toBe(TOKEN);
  });
});

describe("GET /instance/enroll/callback", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.PANTHEON_BASE_ORIGIN = "https://rome-cloud.example";
    process.env.PANTHEON_INSTANCE_ORIGIN = "http://main.rome.localhost:3000";
    delete process.env.PANTHEON_DOMAIN;
    setInstanceTokenInMemory(null);
  });

  afterEach(() => {
    setInstanceTokenInMemory(null);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("provisions the relay mailbox after persisting the newly enrolled token", async () => {
    const store = memoryStore();
    let tokenSeenByProvision: string | null = null;
    const app = mount(depsWithStore(store), {
      fetchImpl: async (input, init) => {
        expect(String(input)).toBe("https://rome-cloud.example/api/instance/token");
        const body = JSON.parse(String(init?.body)) as {
          code?: unknown;
          code_verifier?: unknown;
        };
        expect(body.code).toBe("code_123");
        expect(typeof body.code_verifier).toBe("string");
        return new Response(JSON.stringify({ instanceToken: TOKEN, instanceId: "inst_new" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      ensureRelayMailbox: async () => {
        tokenSeenByProvision = getInstanceToken();
        return { status: "provisioned", mailboxId: "MBOX" };
      },
    });

    const start = await app.request("/instance/enroll/start", { method: "POST" });
    const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
    const state = new URL(authorizeUrl).searchParams.get("state");

    const callback = await app.request(
      `/instance/enroll/callback?state=${encodeURIComponent(state ?? "")}&code=code_123`,
    );

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/?enroll=success");
    expect(store.data.get("instanceToken")).toBe(TOKEN);
    expect(getInstanceToken()).toBe(TOKEN);
    expect(tokenSeenByProvision).toBe(TOKEN);
  });
});
