import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { instanceEnrollRoutes } from "./instance-enroll.js";
import {
  clearInstanceToken,
  getInstanceToken,
  hydrateInstanceToken,
  INSTANCE_KEY_SETTING_KEY,
  INSTANCE_TOKEN_SETTING_KEY,
  isInstanceLinked,
  recheckInstanceIdentity,
  setInstanceTokenInMemory,
} from "../../instance/instance-identity.js";
import { startFakeSigner } from "../../test/fake-signer.js";
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

async function startCallbackPath(app: Hono): Promise<string> {
  const start = await app.request("/instance/enroll/start", { method: "POST" });
  expect(start.status).toBe(200);
  const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
  const state = new URL(authorizeUrl).searchParams.get("state");
  expect(state).toBeTruthy();
  return `/instance/enroll/callback?state=${encodeURIComponent(state ?? "")}&code=code_123`;
}

function successfulExchange(): Response {
  return Response.json({ instanceToken: TOKEN, instanceId: "inst_new" });
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

  it("replays a completed callback without exchanging, persisting, or provisioning again", async () => {
    const store = memoryStore();
    const persist = rs.spyOn(store, "set");
    const fetchImpl = rs.fn(async () => successfulExchange());
    const provisionAfterLink = rs.fn(async () => {});
    const app = mount(depsWithStore(store, { provisionAfterLink }), { fetchImpl });
    const path = await startCallbackPath(app);

    for (let attempt = 0; attempt < 2; attempt++) {
      const callback = await app.request(path);
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/?enroll=success");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(provisionAfterLink).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("shares the in-flight callback when exchange succeeds=%s", async (ok) => {
    let finish!: (response: Response) => void;
    const exchange = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const reason = ok ? "/?enroll=success" : "/connect?enroll=error&reason=exchange";
    const fetchImpl = rs.fn(() => exchange);
    const provisionAfterLink = rs.fn(async () => {});
    const app = mount(depsWithStore(memoryStore(), { provisionAfterLink }), { fetchImpl });
    const path = await startCallbackPath(app);

    const first = app.request(path);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const duplicate = app.request(path);
    finish(ok ? successfulExchange() : Response.json({}, { status: 400 }));

    for (const callback of await Promise.all([first, duplicate])) {
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe(reason);
    }
    if (!ok) {
      const replay = await app.request(path);
      expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provisionAfterLink).toHaveBeenCalledTimes(ok ? 1 : 0);
  });

  it.each([
    "&state=forged",
    "&state=",
    "",
  ])("rejects invalid state (%s) even while enrolled", async (query) => {
    setInstanceTokenInMemory(TOKEN);
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(memoryStore({ instanceToken: TOKEN })), { fetchImpl });

    const callback = await app.request(`/instance/enroll/callback?code=code_123${query}`);
    expect(callback.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a completed state when its replay window expires", async () => {
    let time = 0;
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(memoryStore()), { fetchImpl, now: () => time });
    const path = await startCallbackPath(app);
    const callback = await app.request(path);
    expect(callback.headers.get("location")).toBe("/?enroll=success");

    time += 2 * 60_000;
    const replay = await app.request(path);
    expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a completed state after the local token is cleared", async () => {
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(memoryStore()), { fetchImpl });
    const path = await startCallbackPath(app);
    const callback = await app.request(path);
    expect(callback.headers.get("location")).toBe("/?enroll=success");

    setInstanceTokenInMemory(null);
    const replay = await app.request(path);
    expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different token", "romeinst_replacement_token"],
    ["the same token", TOKEN],
  ])("rejects the old completed state after a clear and re-enrollment with %s", async (_, replacementToken) => {
    const store = memoryStore();
    const fetchImpl = rs
      .fn(async () => Response.json({ instanceToken: replacementToken, instanceId: "inst_2" }))
      .mockImplementationOnce(async () => successfulExchange());
    const app = mount(depsWithStore(store), { fetchImpl, now: () => 0 });
    const firstPath = await startCallbackPath(app);
    const first = await app.request(firstPath);
    expect(first.headers.get("location")).toBe("/?enroll=success");
    expect(getInstanceToken()).toBe(TOKEN);

    await clearInstanceToken(store);
    expect(getInstanceToken()).toBeNull();
    const secondPath = await startCallbackPath(app);
    expect(secondPath).not.toBe(firstPath);
    const second = await app.request(secondPath);
    expect(second.headers.get("location")).toBe("/?enroll=success");
    expect(getInstanceToken()).toBe(replacementToken);

    const replay = await app.request(firstPath);
    expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    const secondReplay = await app.request(secondPath);
    expect(secondReplay.headers.get("location")).toBe("/?enroll=success");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("forgets completed states when a rejected enrollment is replaced", async () => {
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(memoryStore()), {
      fetchImpl,
      proveIdentity: async () => ({ status: "revoked" }),
    });
    const firstPath = await startCallbackPath(app);
    const first = await app.request(firstPath);
    expect(first.headers.get("location")).toBe("/?enroll=success");

    const secondPath = await startCallbackPath(app);
    const second = await app.request(secondPath);
    expect(second.headers.get("location")).toBe("/?enroll=success");
    const replay = await app.request(firstPath);
    expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports an expired pending state once and rejects its replay", async () => {
    let time = 0;
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(memoryStore()), { fetchImpl, now: () => time });
    const path = await startCallbackPath(app);

    time += 10 * 60_000;
    const callback = await app.request(path);
    expect(callback.headers.get("location")).toBe("/connect?enroll=error&reason=expired");
    const replay = await app.request(path);
    expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("starts provisioning after enrollment without waiting for it", async () => {
    const store = memoryStore();
    let tokenSeenByProvision: string | null = null;
    const deps = depsWithStore(store, {
      provisionAfterLink: () => {
        tokenSeenByProvision = getInstanceToken();
        return new Promise<void>(() => {});
      },
    });
    const app = mount(deps, {
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

  it("replays a signer enrollment within 2 minutes until revoked or expired and rejects old states after relinking", async () => {
    const store = memoryStore();
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    let time = 0;
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(store), { fetchImpl, now: () => time });
    let registered = false;
    const register = rs.fn(() => {
      registered = true;
      return Response.json({});
    });
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/instance/key":
          return register();
        case "/api/instance/whoami":
          return registered
            ? Response.json({ instanceId: "inst_new", account: { id: "acct_1" } })
            : Response.json({ error: "invalid_instance_token" }, { status: 401 });
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    try {
      const firstPath = await startCallbackPath(app);
      const first = await app.request(firstPath);
      expect(first.headers.get("location")).toBe("/?enroll=success");
      expect(register).toHaveBeenCalledTimes(1);
      expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
      expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
      expect(getInstanceToken()).toBeNull();
      expect(isInstanceLinked()).toBe(true);

      time = 2 * 60_000 - 1;
      const duplicate = await app.request(firstPath);
      expect(duplicate.headers.get("location")).toBe("/?enroll=success");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(register).toHaveBeenCalledTimes(1);

      registered = false;
      await clearInstanceToken(store);
      expect(isInstanceLinked()).toBe(false);
      const revokedReplay = await app.request(firstPath);
      expect(revokedReplay.headers.get("location")).toBe("/connect?enroll=error&reason=state");

      const secondPath = await startCallbackPath(app);
      const second = await app.request(secondPath);
      expect(second.headers.get("location")).toBe("/?enroll=success");
      expect(register).toHaveBeenCalledTimes(2);
      expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
      expect(isInstanceLinked()).toBe(true);
      const oldReplay = await app.request(firstPath);
      expect(oldReplay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
      const newReplay = await app.request(secondPath);
      expect(newReplay.headers.get("location")).toBe("/?enroll=success");

      time += 2 * 60_000;
      const expiredReplay = await app.request(secondPath);
      expect(expiredReplay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      cloudFetch.mockRestore();
      rs.unstubAllEnvs();
      await clearInstanceToken(store);
      await signer.close();
    }
  });

  it("keeps a signer callback replayable across a deferred key registration retry", async () => {
    const store = memoryStore();
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(store), { fetchImpl, now: () => 0 });
    let allowRegistration = false;
    let registered = false;
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/instance/key":
          if (!allowRegistration) {
            throw new TypeError("cloud temporarily unreachable");
          }
          registered = true;
          return Response.json({});
        case "/api/instance/whoami":
          return registered
            ? Response.json({ instanceId: "inst_new", account: { id: "acct_1" } })
            : Response.json({ error: "invalid_instance_token" }, { status: 401 });
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    try {
      const path = await startCallbackPath(app);
      const first = await app.request(path);
      expect(first.headers.get("location")).toBe("/?enroll=success");
      expect(isInstanceLinked()).toBe(false);
      expect(getInstanceToken()).toBe(TOKEN);

      // Replay works while the one-time token is waiting for the retry.
      const beforeRetryReplay = await app.request(path);
      expect(beforeRetryReplay.headers.get("location")).toBe("/?enroll=success");

      // Once the retry registers the key and drops the one-time token, replay still works.
      allowRegistration = true;
      await recheckInstanceIdentity(store);
      expect(isInstanceLinked()).toBe(true);
      expect(getInstanceToken()).toBeNull();
      const afterRetryReplay = await app.request(path);
      expect(afterRetryReplay.headers.get("location")).toBe("/?enroll=success");

      // Revoking the registered key invalidates the completed state.
      await clearInstanceToken(store);
      const afterClearReplay = await app.request(path);
      expect(afterClearReplay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      cloudFetch.mockRestore();
      rs.unstubAllEnvs();
      await clearInstanceToken(store);
      await signer.close();
    }
  });

  it("reports a registration conflict instead of success, and does not provision", async () => {
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: URL | string) =>
      new URL(String(input)).pathname === "/api/instance/key"
        ? Response.json({ error: "already_bound" }, { status: 409 })
        : Response.json({ error: "invalid_instance_token" }, { status: 401 })) as typeof fetch;
    const provisionAfterLink = rs.fn(async () => {});
    try {
      const app = mount(depsWithStore(memoryStore(), { provisionAfterLink }), {
        fetchImpl: async () =>
          Response.json({ instanceToken: TOKEN, instanceId: "inst_new" }, { status: 200 }),
      });
      const start = await app.request("/instance/enroll/start", { method: "POST" });
      const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
      const state = new URL(authorizeUrl).searchParams.get("state");
      const callback = await app.request(
        `/instance/enroll/callback?state=${encodeURIComponent(state ?? "")}&code=code_123`,
      );
      expect(callback.headers.get("location")).toBe("/connect?enroll=error&reason=key_conflict");
      expect(provisionAfterLink).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
      rs.unstubAllEnvs();
      await signer.close();
    }
  });

  it("preserves callback behavior when signer key registration returns revoked without recording a replay", async () => {
    const store = memoryStore();
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/instance/key":
          return Response.json({ error: "instance_revoked" }, { status: 403 });
        case "/api/instance/whoami":
          return Response.json({ error: "invalid_instance_token" }, { status: 401 });
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    try {
      const app = mount(depsWithStore(store), {
        fetchImpl: async () => successfulExchange(),
      });
      const path = await startCallbackPath(app);
      const first = await app.request(path);
      expect(first.headers.get("location")).toBe("/?enroll=success");
      expect(isInstanceLinked()).toBe(false);
      expect(getInstanceToken()).toBeNull();

      // Because no credential remained linked, replaying the state does not report success.
      const replay = await app.request(path);
      expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    } finally {
      cloudFetch.mockRestore();
      rs.unstubAllEnvs();
      await clearInstanceToken(store);
      await signer.close();
    }
  });

  it("replays signer reconnect callbacks after replacing a revoked key", async () => {
    const store = memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-old" });
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    await hydrateInstanceToken(store);
    const fetchImpl = rs.fn(async () =>
      Response.json({ instanceToken: "romeinst_reconnected", instanceId: "inst_reconnected" }),
    );
    const app = mount(depsWithStore(store), {
      fetchImpl,
      now: () => 0,
      proveIdentity: async () => ({ status: "revoked" }),
    });

    let registered = false;
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/instance/key":
          registered = true;
          return Response.json({});
        case "/api/instance/whoami":
          return registered
            ? Response.json({ instanceId: "inst_reconnected", account: { id: "acct_1" } })
            : Response.json({ error: "instance_revoked" }, { status: 403 });
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    try {
      const start = await app.request("/instance/enroll/start", { method: "POST" });
      expect(start.status).toBe(200);
      const { authorizeUrl } = (await start.json()) as { authorizeUrl: string };
      const state = new URL(authorizeUrl).searchParams.get("state");
      const callbackPath = `/instance/enroll/callback?state=${encodeURIComponent(state ?? "")}&code=code_123`;

      const first = await app.request(callbackPath);
      expect(first.headers.get("location")).toBe("/?enroll=success");
      expect(isInstanceLinked()).toBe(true);
      expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");

      const replay = await app.request(callbackPath);
      expect(replay.headers.get("location")).toBe("/?enroll=success");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      cloudFetch.mockRestore();
      rs.unstubAllEnvs();
      await clearInstanceToken(store);
      await signer.close();
    }
  });
});
