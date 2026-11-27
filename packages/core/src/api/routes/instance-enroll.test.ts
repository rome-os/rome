import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import { instanceEnrollRoutes } from "./instance-enroll.js";
import {
  clearInstanceToken,
  getInstanceIdentityEpoch,
  getInstanceToken,
  hydrateInstanceToken,
  INSTANCE_KEY_SETTING_KEY,
  INSTANCE_TOKEN_SETTING_KEY,
  isInstanceLinked,
  persistInstanceToken,
  setInstanceTokenInMemory,
} from "../../instance/instance-identity.js";
import { runInstanceIdentityHeartbeatTick } from "../../instance/instance-identity-heartbeat.js";
import { RELAY_SETTING_KEY } from "../../relay/settings.js";
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

  it("rejects new exchanges at capacity while sharing an active exchange", async () => {
    let finish!: () => void;
    const exchange = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const fetchImpl = rs.fn(() => exchange.then(successfulExchange));
    const app = mount(depsWithStore(memoryStore()), { fetchImpl });
    const firstPath = await startCallbackPath(app);
    const callbacks = [app.request(firstPath)];
    for (let count = 1; count < 64; count++) {
      callbacks.push(app.request(await startCallbackPath(app)));
    }

    const overflow = app.request(await startCallbackPath(app));
    const duplicate = app.request(firstPath);
    await Promise.resolve();
    finish();

    const [firstResponse, overflowResponse, duplicateResponse, ...restResponses] =
      await Promise.all([callbacks[0], overflow, duplicate, ...callbacks.slice(1)]);
    expect(overflowResponse.headers.get("location")).toBe("/connect?enroll=error&reason=exchange");
    expect(firstResponse.headers.get("location")).toBe("/?enroll=success");
    expect(duplicateResponse.headers.get("location")).toBe("/?enroll=success");
    for (const response of restResponses) {
      expect(response.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    }
    expect(fetchImpl).toHaveBeenCalledTimes(64);
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

  it.each([
    false,
    true,
  ])("rejects a completed state after the local token is cleared (restored: %s)", async (restoreToken) => {
    const fetchImpl = rs.fn(async () => successfulExchange());
    const app = mount(depsWithStore(memoryStore()), { fetchImpl });
    const path = await startCallbackPath(app);
    const callback = await app.request(path);
    expect(callback.headers.get("location")).toBe("/?enroll=success");

    setInstanceTokenInMemory(null);
    if (restoreToken) setInstanceTokenInMemory(TOKEN);
    const replay = await app.request(path);
    expect(replay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a different token", "romeinst_replacement_token"],
    ["the same token", TOKEN],
  ])("rejects the old completed state after a heartbeat clear and re-enrollment with %s", async (_, replacementToken) => {
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
      const beforeEnrollment = getInstanceIdentityEpoch();
      const first = await app.request(firstPath);
      expect(first.headers.get("location")).toBe("/?enroll=success");
      expect(register).toHaveBeenCalledTimes(1);
      expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
      expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
      expect(getInstanceToken()).toBeNull();
      expect(isInstanceLinked()).toBe(true);
      expect(getInstanceIdentityEpoch()).toBe(beforeEnrollment + 1);

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

  it("keeps the newer signer enrollment linked when an older concurrent callback finishes late with 401", async () => {
    const store = memoryStore();
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    const fetchImpl = rs
      .fn(async () => Response.json({ instanceToken: "romeinst_second", instanceId: "inst_2" }))
      .mockImplementationOnce(async () =>
        Response.json({ instanceToken: "romeinst_first", instanceId: "inst_1" }),
      );
    const app = mount(depsWithStore(store), { fetchImpl, now: () => 0 });

    let firstWhoamiStarted!: () => void;
    const firstWhoamiEntered = new Promise<void>((resolve) => {
      firstWhoamiStarted = resolve;
    });
    let releaseFirstWhoami!: () => void;
    let whoamiCount = 0;
    let registered = false;
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/instance/key":
          registered = true;
          return Response.json({});
        case "/api/instance/whoami":
          whoamiCount++;
          if (whoamiCount === 1) {
            firstWhoamiStarted();
            await new Promise<void>((resolve) => {
              releaseFirstWhoami = resolve;
            });
            return Response.json({ error: "invalid_instance_token" }, { status: 401 });
          }
          return registered
            ? Response.json({ instanceId: "inst_2", account: { id: "acct_1" } })
            : Response.json({ error: "invalid_instance_token" }, { status: 401 });
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    try {
      const firstPath = await startCallbackPath(app);
      const firstPromise = app.request(firstPath);
      await firstWhoamiEntered;

      await clearInstanceToken(store);
      const secondPath = await startCallbackPath(app);
      const second = await app.request(secondPath);
      expect(second.headers.get("location")).toBe("/?enroll=success");
      expect(isInstanceLinked()).toBe(true);
      expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");

      releaseFirstWhoami();
      const first = await firstPromise;
      expect(first.headers.get("location")).toBe("/connect?enroll=error&reason=state");

      expect(isInstanceLinked()).toBe(true);
      expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
      const secondReplay = await app.request(secondPath);
      expect(secondReplay.headers.get("location")).toBe("/?enroll=success");
      const firstReplay = await app.request(firstPath);
      expect(firstReplay.headers.get("location")).toBe("/connect?enroll=error&reason=state");
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

  it("rejects an in-flight callback when identity is cleared before the exchange completes", async () => {
    const store = memoryStore();
    let releaseExchange!: (res: Response) => void;
    const fetchImpl = rs.fn(
      () =>
        new Promise<Response>((resolve) => {
          releaseExchange = resolve;
        }),
    );
    const provisionAfterLink = rs.fn(async () => {});
    const app = mount(depsWithStore(store, { provisionAfterLink }), {
      fetchImpl,
      now: () => 0,
    });

    const callbackPath = await startCallbackPath(app);
    const callbackPromise = app.request(callbackPath);
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await clearInstanceToken(store);
    releaseExchange(successfulExchange());

    const callback = await callbackPromise;
    expect(callback.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(provisionAfterLink).not.toHaveBeenCalled();
    expect(getInstanceToken()).toBeNull();
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
  });

  it("does not resurrect a cleared token when clearInstanceToken races a slow store write", async () => {
    const base = memoryStore();
    let setStarted!: () => void;
    const setEntered = new Promise<void>((resolve) => {
      setStarted = resolve;
    });
    let releaseSet!: () => void;
    const store = {
      ...base,
      async set(key: string, value: unknown): Promise<void> {
        if (key === INSTANCE_TOKEN_SETTING_KEY) {
          setStarted();
          await new Promise<void>((resolve) => {
            releaseSet = resolve;
          });
        }
        await base.set(key, value);
      },
    };
    const provisionAfterLink = rs.fn(async () => {});
    const app = mount(depsWithStore(store, { provisionAfterLink }), {
      fetchImpl: async () => successfulExchange(),
      now: () => 0,
    });

    const callbackPath = await startCallbackPath(app);
    const callbackPromise = app.request(callbackPath);
    await setEntered;

    const clearPromise = clearInstanceToken(store);
    releaseSet();

    const [callback] = await Promise.all([callbackPromise, clearPromise]);
    expect(callback.headers.get("location")).toBe("/connect?enroll=error&reason=state");
    expect(provisionAfterLink).not.toHaveBeenCalled();
    expect(getInstanceToken()).toBeNull();
    expect(base.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);

    await hydrateInstanceToken(base);
    expect(getInstanceToken()).toBeNull();
  });

  it("rolls back a superseded store write if the superseding write fails", async () => {
    const base = memoryStore();
    let firstWriteStarted!: () => void;
    const firstWriteEntered = new Promise<void>((resolve) => {
      firstWriteStarted = resolve;
    });
    let releaseFirstWrite!: () => void;
    const store = {
      ...base,
      async set(key: string, value: unknown): Promise<void> {
        if (key === INSTANCE_TOKEN_SETTING_KEY && value === "romeinst_first") {
          firstWriteStarted();
          await new Promise<void>((resolve) => {
            releaseFirstWrite = resolve;
          });
        }
        if (key === INSTANCE_TOKEN_SETTING_KEY && value === "romeinst_second") {
          throw new Error("disk full");
        }
        await base.set(key, value);
      },
    };

    const firstPersist = persistInstanceToken(store, "romeinst_first");
    await firstWriteEntered;
    const secondPersist = persistInstanceToken(store, "romeinst_second").catch((err) => err);
    releaseFirstWrite();

    await firstPersist;
    expect(await secondPersist).toBeInstanceOf(Error);
    expect(getInstanceToken()).toBeNull();
    expect(base.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);

    await hydrateInstanceToken(base);
    expect(getInstanceToken()).toBeNull();
  });

  it("ignores a stale revoked check on /start after a newer identity already enrolled", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: "romeinst_old" });
    await hydrateInstanceToken(store);
    let proveStarted!: () => void;
    const proveEntered = new Promise<void>((resolve) => {
      proveStarted = resolve;
    });
    let releaseProve!: () => void;

    const app = mount(depsWithStore(store), {
      now: () => 0,
      proveIdentity: async () => {
        proveStarted();
        await new Promise<void>((resolve) => {
          releaseProve = resolve;
        });
        return { status: "revoked" };
      },
    });

    const staleStartPromise = app.request("/instance/enroll/start", { method: "POST" });
    await proveEntered;

    await persistInstanceToken(store, "romeinst_fresh");
    expect(getInstanceToken()).toBe("romeinst_fresh");

    releaseProve();
    const staleStart = await staleStartPromise;
    expect(staleStart.status).toBe(409);
    expect(getInstanceToken()).toBe("romeinst_fresh");
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe("romeinst_fresh");
  });

  it("waits for rejected-state relay cleanup to finish before another /start can proceed", async () => {
    const base = memoryStore({
      [INSTANCE_TOKEN_SETTING_KEY]: "romeinst_revoked",
      [RELAY_SETTING_KEY]: { url: "https://old-relay.example" },
    });
    await hydrateInstanceToken(base);
    let relayDeleteStarted!: () => void;
    const relayDeleteEntered = new Promise<void>((resolve) => {
      relayDeleteStarted = resolve;
    });
    let releaseRelayDelete!: () => void;
    let relayDeleteDone = false;
    const store = {
      ...base,
      async delete(key: string): Promise<void> {
        if (key === RELAY_SETTING_KEY) {
          relayDeleteStarted();
          await new Promise<void>((resolve) => {
            releaseRelayDelete = resolve;
          });
          relayDeleteDone = true;
        }
        await base.delete(key);
      },
    };
    const reload = rs.fn(async () => {});
    const app = mount(depsWithStore(store, { relayDrainer: { reload } as never }), {
      now: () => 0,
      proveIdentity: async () => ({ status: "revoked" }),
    });

    const firstStartPromise = app.request("/instance/enroll/start", { method: "POST" });
    await relayDeleteEntered;

    let secondStartResolved = false;
    const secondStartPromise = Promise.resolve(
      app.request("/instance/enroll/start", { method: "POST" }),
    ).then((res) => {
      secondStartResolved = true;
      return res;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondStartResolved).toBe(false);
    expect(relayDeleteDone).toBe(false);

    releaseRelayDelete();
    const [firstStart, secondStart] = await Promise.all([firstStartPromise, secondStartPromise]);
    expect(firstStart.status).toBe(200);
    expect(secondStart.status).toBe(200);
    expect(relayDeleteDone).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(base.data.has(RELAY_SETTING_KEY)).toBe(false);
  });

  it("blocks a second /start until in-flight signer registration settles and returns 409", async () => {
    const store = memoryStore();
    const signer = await startFakeSigner({ aud: "https://rome-cloud.example" });
    rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
    let registerStarted!: () => void;
    const registerEntered = new Promise<void>((resolve) => {
      registerStarted = resolve;
    });
    let releaseRegister!: () => void;
    let registered = false;
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      switch (new URL(String(input)).pathname) {
        case "/api/instance/key":
          registerStarted();
          await new Promise<void>((resolve) => {
            releaseRegister = resolve;
          });
          registered = true;
          return Response.json({});
        case "/api/instance/whoami":
          return registered
            ? Response.json({ instanceId: "inst_1", account: { id: "acct_1" } })
            : Response.json({ error: "invalid_instance_token" }, { status: 401 });
        default:
          throw new Error(`unexpected request: ${input}`);
      }
    });
    try {
      const app = mount(depsWithStore(store), {
        fetchImpl: async () => successfulExchange(),
        now: () => 0,
        proveIdentity: async () => ({
          status: "ok",
          identity: { accountId: "acct_1", instanceId: "inst_1" },
        }),
      });
      const firstPath = await startCallbackPath(app);
      const firstPromise = app.request(firstPath);
      await registerEntered;
      expect(isInstanceLinked()).toBe(false);

      let secondStartResolved = false;
      const secondStartPromise = Promise.resolve(
        app.request("/instance/enroll/start", { method: "POST" }),
      ).then((res) => {
        secondStartResolved = true;
        return res;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(secondStartResolved).toBe(false);

      releaseRegister();
      const [first, secondStart] = await Promise.all([firstPromise, secondStartPromise]);
      expect(first.headers.get("location")).toBe("/?enroll=success");
      expect(secondStart.status).toBe(409);
      const replay = await app.request(firstPath);
      expect(replay.headers.get("location")).toBe("/?enroll=success");
    } finally {
      cloudFetch.mockRestore();
      rs.unstubAllEnvs();
      await clearInstanceToken(store);
      await signer.close();
    }
  });

  it("does not clear a newly enrolled legacy token when a stale heartbeat returns 403", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: "romeinst_old" });
    await hydrateInstanceToken(store);
    let whoamiStarted!: () => void;
    const whoamiEntered = new Promise<void>((resolve) => {
      whoamiStarted = resolve;
    });
    let releaseWhoami!: () => void;
    const cloudFetch = rs.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (new URL(String(input)).pathname === "/api/instance/whoami") {
        whoamiStarted();
        await new Promise<void>((resolve) => {
          releaseWhoami = resolve;
        });
        return Response.json({ error: "instance_revoked" }, { status: 403 });
      }
      throw new Error(`unexpected request: ${input}`);
    });
    try {
      const heartbeatPromise = runInstanceIdentityHeartbeatTick({ store });
      await whoamiEntered;

      await persistInstanceToken(store, "romeinst_fresh");
      expect(getInstanceToken()).toBe("romeinst_fresh");

      releaseWhoami();
      await heartbeatPromise;

      expect(getInstanceToken()).toBe("romeinst_fresh");
      expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe("romeinst_fresh");
    } finally {
      cloudFetch.mockRestore();
      await clearInstanceToken(store);
    }
  });
});
