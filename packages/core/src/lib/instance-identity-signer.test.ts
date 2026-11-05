import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  cloudBearer,
  getIdentityIssue,
  getInstanceToken,
  hydrateInstanceToken,
  INSTANCE_KEY_SETTING_KEY,
  INSTANCE_TOKEN_SETTING_KEY,
  instanceCredentialId,
  isInstanceLinked,
  persistInstanceToken,
  seedInstanceTokenFromEnv,
  syncInstanceIdentity,
} from "./instance-identity.js";

const TOKEN = "romeinst_abc123def456";
const ORIGIN = "https://rome-cloud.example";

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

// A signer on a real unix socket: each token is a distinct JWT-shaped string.
let signer: Server | undefined;
let directory = "";
let issued = 0;
async function startSigner() {
  directory = await mkdtemp(join(tmpdir(), "rome-identity-signer-"));
  const socketPath = join(directory, "signer.sock");
  signer = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/health") res.end(JSON.stringify({ ok: true, jkt: "jkt-1" }));
    else res.end(JSON.stringify({ token: `eyJ${++issued}.e30.sig` }));
  });
  await new Promise<void>((resolve) => signer!.listen(socketPath, resolve));
  rs.stubEnv("ROME_SIGNER_SOCKET", socketPath);
}

type Handler = (init: RequestInit) => Response;
// Routes fake Rome Cloud responses by path, and records what was sent.
function cloud(routes: Record<string, Handler>) {
  const calls: Array<{ path: string; authorization: string; body?: string }> = [];
  const fetchImpl = (async (input: URL | string, init: RequestInit = {}) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init.headers);
    calls.push({
      path,
      authorization: headers.get("authorization") ?? "",
      body: typeof init.body === "string" ? init.body : undefined,
    });
    return (routes[path] ?? (() => new Response("{}", { status: 404 })))(init);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

// Captures the 30-second recheck instead of waiting for it. The callback runs on demand.
function captureRecheck() {
  const original = globalThis.setTimeout;
  let callback: (() => void) | undefined;
  let delay: number | undefined;
  rs.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
    if (ms !== 30_000) return original(fn, ms);
    callback = fn;
    delay = ms;
    return original(() => {}, 0);
  }) as typeof setTimeout);
  return { delay: () => delay, run: () => callback?.() };
}

const realFetch = globalThis.fetch;

const whoami =
  (status: number, body: unknown = {}): Handler =>
  () =>
    Response.json(body, { status });
const IDENTITY = { instanceId: "inst-1", account: { id: "acct-1", email: "a@example.com" } };

beforeEach(async () => {
  rs.stubEnv("PANTHEON_BASE_ORIGIN", ORIGIN);
  rs.stubEnv("ROME_INSTANCE_TOKEN", "");
  await hydrateInstanceToken(memoryStore());
});

afterEach(async () => {
  rs.restoreAllMocks();
  globalThis.fetch = realFetch;
  rs.unstubAllEnvs();
  signer?.close();
  signer = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = "";
});

describe("legacy mode (no signer socket)", () => {
  it("bears the instance token and is linked by it", async () => {
    await hydrateInstanceToken(memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN }));
    expect(await cloudBearer()).toBe(TOKEN);
    expect(isInstanceLinked()).toBe(true);
    expect(instanceCredentialId()).toBe(TOKEN);
  });

  it("has no bearer without a token", async () => {
    expect(await cloudBearer()).toBeNull();
    expect(isInstanceLinked()).toBe(false);
  });

  it("surfaces 426 as upgrade_required and keeps the token", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    const { fetchImpl } = cloud({
      "/api/instance/whoami": whoami(426, { error: "upgrade_required" }),
    });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "upgrade_required",
    });
    expect(getInstanceToken()).toBe(TOKEN);
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    expect(getIdentityIssue()?.message).toBe("Update your compose file to add the signer service.");
  });

  it("seeds the env token as before", async () => {
    rs.stubEnv("ROME_INSTANCE_TOKEN", TOKEN);
    const store = memoryStore();
    expect(await seedInstanceTokenFromEnv(store)).toBe(true);
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
  });
});

describe("signer mode", () => {
  beforeEach(startSigner);

  it("sends a fresh signer token for every call once linked", async () => {
    await hydrateInstanceToken(memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" }));
    const first = await cloudBearer();
    const second = await cloudBearer();
    expect(first).toMatch(/^eyJ/);
    expect(second).toMatch(/^eyJ/);
    expect(second).not.toBe(first);
    expect(instanceCredentialId()).toBe("jkt-1");
  });

  it("has no bearer before the key is registered, even with a token on hand", async () => {
    await hydrateInstanceToken(memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN }));
    expect(await cloudBearer()).toBeNull();
    expect(isInstanceLinked()).toBe(false);
  });

  it("does not seed the env token into settings", async () => {
    rs.stubEnv("ROME_INSTANCE_TOKEN", TOKEN);
    const store = memoryStore();
    expect(await seedInstanceTokenFromEnv(store)).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it("1: links on a 200 whoami and deletes a stored instance token", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    const { fetchImpl, calls } = cloud({ "/api/instance/whoami": whoami(200, IDENTITY) });
    const result = await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(result.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].authorization).toMatch(/^Bearer eyJ/);
    expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
    expect(getInstanceToken()).toBeNull();
    expect(isInstanceLinked()).toBe(true);
    expect(getIdentityIssue()).toBeNull();
  });

  it("2: registers the key with the stored instance token on a 401, then deletes the token", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    let known = false;
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": () =>
        known
          ? Response.json(IDENTITY)
          : Response.json({ error: "invalid_instance_token" }, { status: 401 }),
      "/api/instance/key": () => {
        known = true;
        return Response.json({ instanceId: "inst-1" });
      },
    });
    const result = await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(result.status).toBe("ok");
    const registration = calls.find((call) => call.path === "/api/instance/key")!;
    expect(registration.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(registration.body!).assertion).toMatch(/^eyJ/);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
    expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
    expect(isInstanceLinked()).toBe(true);
  });

  it("2: registers with the hosted env token without storing it", async () => {
    rs.stubEnv("ROME_INSTANCE_TOKEN", TOKEN);
    const store = memoryStore();
    let known = false;
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": () =>
        known ? Response.json(IDENTITY) : Response.json({}, { status: 401 }),
      "/api/instance/key": () => {
        known = true;
        return Response.json({ instanceId: "inst-1" });
      },
    });
    expect((await syncInstanceIdentity(store, { fetch: fetchImpl })).status).toBe("ok");
    expect(calls.find((call) => call.path === "/api/instance/key")!.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect([...store.data.keys()]).toEqual([INSTANCE_KEY_SETTING_KEY]);
  });

  it.each([
    "already_bound",
    "key_in_use",
  ])("3: reports key_conflict on a 409 %s and drops the unusable token", async (error) => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    const { fetchImpl } = cloud({
      "/api/instance/whoami": whoami(401, { error: "invalid_instance_token" }),
      "/api/instance/key": whoami(409, { error }),
    });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "key_conflict",
    });
    expect(isInstanceLinked()).toBe(false);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
    expect(getIdentityIssue()?.message).toBe(
      "This instance's credential was registered elsewhere. Sign in again.",
    );
  });

  it("4: asks for sign-in on a 401 when no instance token is on hand", async () => {
    const store = memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" });
    await hydrateInstanceToken(store);
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(401, { error: "invalid_instance_token" }),
    });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({ status: "unknown" });
    expect(calls.map((call) => call.path)).toEqual(["/api/instance/whoami"]);
    expect(isInstanceLinked()).toBe(false);
    expect(store.data.has(INSTANCE_KEY_SETTING_KEY)).toBe(false);
  });

  it("4: registers right after sign-in mints an instance token", async () => {
    const store = memoryStore();
    let known = false;
    const { fetchImpl } = cloud({
      "/api/instance/whoami": () =>
        known ? Response.json(IDENTITY) : Response.json({}, { status: 401 }),
      "/api/instance/key": () => {
        known = true;
        return Response.json({ instanceId: "inst-1" });
      },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;
    try {
      await persistInstanceToken(store, TOKEN);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(isInstanceLinked()).toBe(true);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
  });

  it("5: keeps every credential when the signer is down, and rechecks in 30 seconds", async () => {
    const store = memoryStore({
      [INSTANCE_TOKEN_SETTING_KEY]: TOKEN,
      [INSTANCE_KEY_SETTING_KEY]: "jkt-1",
    });
    await hydrateInstanceToken(store);
    rs.stubEnv("ROME_SIGNER_SOCKET", join(directory, "missing.sock"));
    const recheck = captureRecheck();
    const { fetchImpl, calls } = cloud({ "/api/instance/whoami": whoami(200, IDENTITY) });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "signer_unavailable",
    });
    expect(calls).toHaveLength(0);
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
    expect(getIdentityIssue()?.message).toBe("Signing service is not running.");

    expect(recheck.delay()).toBe(30_000);
    rs.stubEnv("ROME_SIGNER_SOCKET", join(directory, "signer.sock"));
    globalThis.fetch = fetchImpl;
    recheck.run();
    await rs.waitFor(() => expect(getIdentityIssue()).toBeNull());
    expect(isInstanceLinked()).toBe(true);
  });

  it("6: keeps everything on clock_skew and rechecks in 30 seconds", async () => {
    const store = memoryStore({
      [INSTANCE_TOKEN_SETTING_KEY]: TOKEN,
      [INSTANCE_KEY_SETTING_KEY]: "jkt-1",
    });
    await hydrateInstanceToken(store);
    const recheck = captureRecheck();
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(401, { error: "clock_skew" }),
    });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "clock_skew",
    });
    expect(calls.map((call) => call.path)).toEqual(["/api/instance/whoami"]);
    expect(isInstanceLinked()).toBe(true);
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    expect(getIdentityIssue()?.message).toBe("System clock is off.");
    expect(recheck.delay()).toBe(30_000);
  });

  it("6: keeps the token when registration hits clock_skew", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    captureRecheck();
    const { fetchImpl } = cloud({
      "/api/instance/whoami": whoami(401, { error: "invalid_instance_token" }),
      "/api/instance/key": whoami(401, { error: "clock_skew" }),
    });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "clock_skew",
    });
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
  });
});
