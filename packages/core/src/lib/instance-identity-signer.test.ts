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
  onInstanceLinked,
  persistInstanceToken,
  recheckInstanceIdentity,
  seedInstanceTokenFromEnv,
  syncInstanceIdentity,
} from "./instance-identity.js";
import { startFakeSigner } from "../test/fake-signer.js";

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

let signer: Awaited<ReturnType<typeof startFakeSigner>> | undefined;
async function startSigner(aud = ORIGIN) {
  signer = await startFakeSigner({ aud });
  rs.stubEnv("ROME_SIGNER_SOCKET", signer.socketPath);
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
  await signer?.close();
  signer = undefined;
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
  beforeEach(() => startSigner());

  it("reuses one signer token until shortly before it expires", async () => {
    await hydrateInstanceToken(memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" }));
    const first = await cloudBearer();
    const second = await cloudBearer();
    expect(first).toMatch(/^eyJ/);
    expect(second).toBe(first);
    expect(signer!.state.issued).toBe(1);
    expect(instanceCredentialId()).toBe("jkt-1");
  });

  it("asks the signer again when the token is within 15 seconds of its expiry", async () => {
    signer!.state.lifetimeSeconds = 10;
    await hydrateInstanceToken(memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" }));
    const first = await cloudBearer();
    const second = await cloudBearer();
    expect(second).not.toBe(first);
    expect(signer!.state.issued).toBe(2);
  });

  it("shares one signer request between concurrent callers", async () => {
    await hydrateInstanceToken(memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" }));
    const tokens = await Promise.all([cloudBearer(), cloudBearer(), cloudBearer(), cloudBearer()]);
    expect(new Set(tokens).size).toBe(1);
    expect(signer!.state.issued).toBe(1);
  });

  it("drops the cached token when Rome Cloud rejects a signer token", async () => {
    const store = memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" });
    await hydrateInstanceToken(store);
    const before = await cloudBearer();
    const { fetchImpl } = cloud({ "/api/instance/whoami": whoami(401, { error: "clock_skew" }) });
    captureRecheck();
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(isInstanceLinked()).toBe(true);
    expect(await cloudBearer()).not.toBe(before);
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
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": whoami(200, { instanceId: "inst-1" }),
    });
    const result = await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(result.status).toBe("ok");
    expect(calls.map((call) => call.path)).toEqual([
      "/api/instance/whoami",
      "/api/instance/key/hosted-link",
    ]);
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
    rs.stubEnv("ROME_SIGNER_SOCKET", "/nonexistent/signer.sock");
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
    rs.stubEnv("ROME_SIGNER_SOCKET", signer!.socketPath);
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

describe("signer mode: a hosted enrollment while the signer already authenticates", () => {
  beforeEach(() => startSigner());

  async function linked(token = TOKEN) {
    const store = memoryStore({
      [INSTANCE_KEY_SETTING_KEY]: "jkt-1",
      [INSTANCE_TOKEN_SETTING_KEY]: token,
    });
    await hydrateInstanceToken(store);
    return store;
  }

  it("moves the hosted link onto the credential in use and drops the enrollment", async () => {
    const store = await linked();
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": whoami(200, { instanceId: "inst-1" }),
    });
    expect((await syncInstanceIdentity(store, { fetch: fetchImpl })).status).toBe("ok");
    const handshake = calls.find((call) => call.path === "/api/instance/key/hosted-link")!;
    expect(handshake.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(handshake.body!).assertion).toMatch(/^eyJ/);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
    expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");

    // Offered once: the next check does not call again.
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(calls.filter((call) => call.path.endsWith("/hosted-link"))).toHaveLength(1);
  });

  it("keeps the enrollment against a Rome Cloud without the endpoint, and offers it again after a restart", async () => {
    const store = await linked();
    const { fetchImpl, calls } = cloud({ "/api/instance/whoami": whoami(200, IDENTITY) });
    expect((await syncInstanceIdentity(store, { fetch: fetchImpl })).status).toBe("ok");
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    expect(isInstanceLinked()).toBe(true);
    expect(calls.filter((call) => call.path.endsWith("/hosted-link"))).toHaveLength(1);

    // Rome Cloud deploys the endpoint; the next boot links.
    await hydrateInstanceToken(store);
    const deployed = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": whoami(200, { instanceId: "inst-1" }),
    });
    await syncInstanceIdentity(store, { fetch: deployed.fetchImpl });
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
  });

  it("keeps the enrollment after a 5xx or a network error and offers it at the next check", async () => {
    const store = await linked();
    let failures = 0;
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": () => {
        failures += 1;
        if (failures === 1) return Response.json({}, { status: 503 });
        if (failures === 2) throw new Error("network down");
        return Response.json({ instanceId: "inst-1" });
      },
    });
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
    expect(calls.filter((call) => call.path.endsWith("/hosted-link"))).toHaveLength(3);
  });

  it.each([
    "already_bound",
    "key_not_registered",
  ])("falls back to the usual key registration on a 409 %s", async (error) => {
    const store = await linked();
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": whoami(409, { error }),
      "/api/instance/key": whoami(200, { instanceId: "inst-1" }),
    });
    expect((await syncInstanceIdentity(store, { fetch: fetchImpl })).status).toBe("ok");
    const registration = calls.find((call) => call.path === "/api/instance/key")!;
    expect(registration.authorization).toBe(`Bearer ${TOKEN}`);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
  });

  it.each([
    [409, "not_hosted_enrollment"],
    [409, "account_mismatch"],
    [401, "invalid_instance_token"],
    [403, "instance_revoked"],
    [400, "invalid_assertion"],
  ])("drops the enrollment on a %s %s and keeps the credential in use", async (status, error) => {
    const store = await linked();
    const { fetchImpl, calls } = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": whoami(status, { error }),
    });
    expect((await syncInstanceIdentity(store, { fetch: fetchImpl })).status).toBe("ok");
    expect(calls.some((call) => call.path === "/api/instance/key")).toBe(false);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
    expect(isInstanceLinked()).toBe(true);
  });

  it("keeps the enrollment on clock skew", async () => {
    const store = await linked();
    const { fetchImpl } = cloud({
      "/api/instance/whoami": whoami(200, IDENTITY),
      "/api/instance/key/hosted-link": whoami(401, { error: "clock_skew" }),
    });
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
  });

  it("calls nothing extra when no instance token is on hand", async () => {
    const store = memoryStore({ [INSTANCE_KEY_SETTING_KEY]: "jkt-1" });
    await hydrateInstanceToken(store);
    const { fetchImpl, calls } = cloud({ "/api/instance/whoami": whoami(200, IDENTITY) });
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(calls.map((call) => call.path)).toEqual(["/api/instance/whoami"]);
  });
});

describe("signer mode before the key is registered", () => {
  beforeEach(() => startSigner());

  const unauthorized = whoami(401, { error: "invalid_instance_token" });

  it("keeps working with the instance token, then switches to signer tokens once linked", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    expect(await cloudBearer()).toBe(TOKEN);
    expect(isInstanceLinked()).toBe(false);

    let known = false;
    const { fetchImpl } = cloud({
      "/api/instance/whoami": () => (known ? Response.json(IDENTITY) : unauthorized({})),
      "/api/instance/key": () => {
        known = true;
        return Response.json({ instanceId: "inst-1" });
      },
    });
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(await cloudBearer()).toMatch(/^eyJ/);
  });

  it("offers the hosted env token the same way", async () => {
    rs.stubEnv("ROME_INSTANCE_TOKEN", TOKEN);
    expect(await cloudBearer()).toBe(TOKEN);
  });

  it("stops offering an instance token that registration found unusable", async () => {
    rs.stubEnv("ROME_INSTANCE_TOKEN", "romeinst_retired_env");
    const store = memoryStore();
    const { fetchImpl } = cloud({
      "/api/instance/whoami": unauthorized,
      "/api/instance/key": whoami(409, { error: "already_bound" }),
    });
    expect(await cloudBearer()).toBe("romeinst_retired_env");
    await syncInstanceIdentity(store, { fetch: fetchImpl });
    expect(await cloudBearer()).toBeNull();
  });

  it("retries an unreachable registration in 30 seconds and links then", async () => {
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    const recheck = captureRecheck();
    const linked = rs.fn();
    onInstanceLinked(linked);
    let reachable = false;
    const { fetchImpl } = cloud({
      "/api/instance/whoami": () => (reachable ? Response.json(IDENTITY) : unauthorized({})),
      "/api/instance/key": () => {
        if (!reachable) throw new Error("network down");
        return Response.json({ instanceId: "inst-1" });
      },
      "/api/instance/key/hosted-link": whoami(409, { error: "already_bound" }),
    });
    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "unreachable",
    });
    expect(recheck.delay()).toBe(30_000);
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    expect(isInstanceLinked()).toBe(false);
    expect(linked).not.toHaveBeenCalled();

    reachable = true;
    globalThis.fetch = fetchImpl;
    recheck.run();
    await rs.waitFor(() => expect(isInstanceLinked()).toBe(true));
    expect(linked).toHaveBeenCalledTimes(1);
    expect(store.data.has(INSTANCE_TOKEN_SETTING_KEY)).toBe(false);
  });

  it("retries when Rome Cloud is unreachable at the first check", async () => {
    await hydrateInstanceToken(memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN }));
    const recheck = captureRecheck();
    const { fetchImpl } = cloud({
      "/api/instance/whoami": () => {
        throw new Error("network down");
      },
    });
    const result = await syncInstanceIdentity(memoryStore(), { fetch: fetchImpl });
    expect(result.status).toBe("unreachable");
    expect(recheck.delay()).toBe(30_000);
  });

  it("does not retry an unreachable check when there is no instance token to register", async () => {
    await hydrateInstanceToken(memoryStore());
    const recheck = captureRecheck();
    const { fetchImpl } = cloud({
      "/api/instance/whoami": () => {
        throw new Error("network down");
      },
    });
    await syncInstanceIdentity(memoryStore(), { fetch: fetchImpl });
    expect(recheck.delay()).toBeUndefined();
  });

  it("reports the registration result to the sign-in that minted the token", async () => {
    const store = memoryStore();
    const { fetchImpl } = cloud({
      "/api/instance/whoami": unauthorized,
      "/api/instance/key": whoami(409, { error: "already_bound" }),
    });
    globalThis.fetch = fetchImpl;
    expect(await persistInstanceToken(store, TOKEN)).toEqual({ status: "key_conflict" });
    expect(isInstanceLinked()).toBe(false);
  });

  it("only runs link listeners for background rechecks, not for the boot check", async () => {
    const linked = rs.fn();
    onInstanceLinked(linked);
    const store = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(store);
    let known = false;
    const { fetchImpl } = cloud({
      "/api/instance/whoami": () => (known ? Response.json(IDENTITY) : unauthorized({})),
      "/api/instance/key": () => {
        known = true;
        return Response.json({ instanceId: "inst-1" });
      },
    });
    await syncInstanceIdentity(store, { bootVersion: "1.0.0", fetch: fetchImpl });
    expect(isInstanceLinked()).toBe(true);
    expect(linked).not.toHaveBeenCalled();

    const other = memoryStore({ [INSTANCE_TOKEN_SETTING_KEY]: TOKEN });
    await hydrateInstanceToken(other);
    known = false;
    globalThis.fetch = fetchImpl;
    await recheckInstanceIdentity(other);
    expect(linked).toHaveBeenCalledTimes(1);
  });
});

describe("signer audience", () => {
  it("does not register, unlink or clear anything when the signer serves another Rome Cloud", async () => {
    await startSigner("https://other-cloud.example");
    const store = memoryStore({
      [INSTANCE_TOKEN_SETTING_KEY]: TOKEN,
      [INSTANCE_KEY_SETTING_KEY]: "jkt-1",
    });
    await hydrateInstanceToken(store);
    const recheck = captureRecheck();
    const { fetchImpl, calls } = cloud({ "/api/instance/whoami": whoami(401) });

    expect(await syncInstanceIdentity(store, { fetch: fetchImpl })).toEqual({
      status: "audience_mismatch",
    });
    expect(calls).toHaveLength(0);
    expect(isInstanceLinked()).toBe(true);
    expect(store.data.get(INSTANCE_TOKEN_SETTING_KEY)).toBe(TOKEN);
    expect(store.data.get(INSTANCE_KEY_SETTING_KEY)).toBe("jkt-1");
    expect(getIdentityIssue()?.message).toBe(
      "The signing service is configured for a different Rome Cloud address.",
    );
    expect(recheck.delay()).toBe(30_000);

    // The signer is corrected; the next check clears the issue.
    signer!.state.aud = ORIGIN;
    globalThis.fetch = (async () => Response.json(IDENTITY)) as typeof fetch;
    recheck.run();
    await rs.waitFor(() => expect(getIdentityIssue()).toBeNull());
  });
});
