import { describe, expect, it } from "@rstest/core";
import { buildOriginPolicy } from "./origin-allowlist.js";
import {
  clearInstanceOrigin,
  INSTANCE_ORIGIN_KEY,
  loadInstanceOrigin,
  saveInstanceOrigin,
  type KeyValueStorage,
} from "./instance-store.js";

const policy = buildOriginPolicy({
  romeCloudOrigin: "https://rome.example",
  instanceDomain: "rome.example",
});

interface FakeStorage extends KeyValueStorage {
  map: Map<string, string>;
}

function makeStorage(initial: Record<string, string> = {}): FakeStorage {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
}

function makeThrowingStorage(): KeyValueStorage {
  const boom = async (): Promise<never> => {
    throw new Error("storage unavailable");
  };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

/** A stored value in the environment-scoped JSON format, defaulting to `policy`'s environment. */
function storedJson(origin: string, overrides: Partial<Record<string, string>> = {}): string {
  return JSON.stringify({
    origin,
    romeCloudOrigin: "https://rome.example",
    instanceDomain: "rome.example",
    ...overrides,
  });
}

/** The remembered origin currently in storage, or undefined. */
function storedOrigin(storage: FakeStorage): string | undefined {
  const raw = storage.map.get(INSTANCE_ORIGIN_KEY);
  return raw === undefined ? undefined : (JSON.parse(raw) as { origin: string }).origin;
}

describe("loadInstanceOrigin", () => {
  it("returns null when nothing is stored", async () => {
    expect(await loadInstanceOrigin(makeStorage(), policy)).toBe(null);
  });

  it("returns a stored instance origin", async () => {
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: storedJson("https://abc.rome.example") });
    expect(await loadInstanceOrigin(storage, policy)).toBe("https://abc.rome.example");
  });

  it("honors a record written before the Rome Cloud rename", async () => {
    // Shipped builds wrote `pantheonOrigin` under this same key. Upgrading
    // into this build must not forget the user's remembered instance.
    const storage = makeStorage({
      [INSTANCE_ORIGIN_KEY]: JSON.stringify({
        origin: "https://abc.rome.example",
        pantheonOrigin: "https://rome.example",
        instanceDomain: "rome.example",
      }),
    });
    expect(await loadInstanceOrigin(storage, policy)).toBe("https://abc.rome.example");
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(true);
  });

  it("still environment-scopes a record written before the rename", async () => {
    // The legacy field is read, not trusted — a record remembered under a
    // different Rome Cloud stays rejected.
    const storage = makeStorage({
      [INSTANCE_ORIGIN_KEY]: JSON.stringify({
        origin: "https://abc.rome.example",
        pantheonOrigin: "https://other-rome-cloud.example",
        instanceDomain: "rome.example",
      }),
    });
    expect(await loadInstanceOrigin(storage, policy)).toBe(null);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("rejects and clears a stored value that is no longer an instance origin", async () => {
    // e.g. the configured instance domain changed between builds, or the value
    // was corrupted — never navigate to an origin the current policy rejects.
    const storage = makeStorage({
      [INSTANCE_ORIGIN_KEY]: storedJson("https://abc.other.example"),
    });
    expect(await loadInstanceOrigin(storage, policy)).toBe(null);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("rejects and clears a malformed stored value", async () => {
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: "not a url" });
    expect(await loadInstanceOrigin(storage, policy)).toBe(null);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("rejects and clears a legacy bare-origin value (no environment metadata)", async () => {
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: "https://abc.rome.example" });
    expect(await loadInstanceOrigin(storage, policy)).toBe(null);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("rejects and clears a value remembered under a different environment", async () => {
    // Same instanceDomain, different Rome Cloud — the one case the load-time
    // policy check alone cannot distinguish.
    const otherRomeCloud = makeStorage({
      [INSTANCE_ORIGIN_KEY]: storedJson("https://abc.rome.example", {
        romeCloudOrigin: "https://other-rome-cloud.example",
      }),
    });
    expect(await loadInstanceOrigin(otherRomeCloud, policy)).toBe(null);
    expect(otherRomeCloud.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);

    const otherDomain = makeStorage({
      [INSTANCE_ORIGIN_KEY]: storedJson("https://abc.rome.example", {
        instanceDomain: "other.example",
      }),
    });
    expect(await loadInstanceOrigin(otherDomain, policy)).toBe(null);
    expect(otherDomain.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("returns null when storage throws", async () => {
    expect(await loadInstanceOrigin(makeThrowingStorage(), policy)).toBe(null);
  });
});

describe("saveInstanceOrigin", () => {
  // The gate signal: the hop into the instance came from a Rome Cloud page.
  const fromRomeCloud = "https://rome.example/dashboard";

  it("stores the bare origin of an instance URL reached from Rome Cloud, scoped to the environment", async () => {
    const storage = makeStorage();
    await saveInstanceOrigin(storage, "https://abc.rome.example/chat?x=1", policy, fromRomeCloud);
    expect(JSON.parse(storage.map.get(INSTANCE_ORIGIN_KEY) ?? "null")).toEqual({
      origin: "https://abc.rome.example",
      romeCloudOrigin: "https://rome.example",
      instanceDomain: "rome.example",
    });
  });

  it("ignores non-instance URLs (Rome Cloud, auth hosts, junk)", async () => {
    const storage = makeStorage();
    await saveInstanceOrigin(storage, "https://rome.example/dashboard", policy, fromRomeCloud);
    await saveInstanceOrigin(storage, "https://accounts.google.com/signin", policy, fromRomeCloud);
    await saveInstanceOrigin(storage, "not a url", policy, fromRomeCloud);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("overwrites a previously stored instance origin on a new Rome Cloud hop", async () => {
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: storedJson("https://old.rome.example") });
    const selected = await saveInstanceOrigin(
      storage,
      "https://new.rome.example/",
      policy,
      fromRomeCloud,
    );
    expect(storedOrigin(storage)).toBe("https://new.rome.example");
    expect(selected).toBe("https://new.rome.example");
  });

  it("does not remember an instance reached from another instance (cross-tenant link)", async () => {
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: storedJson("https://old.rome.example") });
    const selected = await saveInstanceOrigin(
      storage,
      "https://evil-tenant.rome.example/",
      policy,
      "https://old.rome.example/chat",
    );
    expect(storedOrigin(storage)).toBe("https://old.rome.example");
    expect(selected).toBeNull();
  });

  it("does not remember on a cold start (no previous main-frame URL)", async () => {
    const storage = makeStorage();
    await saveInstanceOrigin(storage, "https://abc.rome.example/", policy, null);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("does not remember when the hop came from an auth origin", async () => {
    const authPolicy = buildOriginPolicy({
      romeCloudOrigin: "https://rome.example",
      instanceDomain: "rome.example",
      authOrigins: ["https://accounts.google.com"],
    });
    const storage = makeStorage();
    await saveInstanceOrigin(
      storage,
      "https://abc.rome.example/",
      authPolicy,
      "https://accounts.google.com/signin",
    );
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("does not remember when the previous URL is malformed", async () => {
    const storage = makeStorage();
    await saveInstanceOrigin(storage, "https://abc.rome.example/", policy, "not a url");
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("does not remember reserved sibling hosts, even on a Rome Cloud hop", async () => {
    // A Rome Cloud page linking to the store preview (demo.<domain>) or another
    // operational sibling must never overwrite the remembered instance.
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: storedJson("https://abc.rome.example") });
    await saveInstanceOrigin(storage, "https://demo.rome.example/", policy, fromRomeCloud);
    await saveInstanceOrigin(
      storage,
      "https://public-assets.rome.example/x",
      policy,
      fromRomeCloud,
    );
    expect(storedOrigin(storage)).toBe("https://abc.rome.example");
  });

  it("round-trips: a saved instance is loadable under the same policy", async () => {
    const storage = makeStorage();
    await saveInstanceOrigin(storage, "https://abc.rome.example/chat", policy, fromRomeCloud);
    expect(await loadInstanceOrigin(storage, policy)).toBe("https://abc.rome.example");
  });

  it("swallows storage failures (navigation must not break)", async () => {
    await expect(
      saveInstanceOrigin(makeThrowingStorage(), "https://abc.rome.example", policy, fromRomeCloud),
    ).resolves.toBeNull();
  });

  it("never remembers an exact-origin page even if it also matches the instance-domain rule", async () => {
    // If Rome Cloud is ever deployed as a single-label subdomain of the instance
    // domain, isInstanceUrl would match it too — every Rome Cloud page view must
    // not overwrite the remembered instance.
    const subdomainPolicy = buildOriginPolicy({
      romeCloudOrigin: "https://cloud.rome.example",
      instanceDomain: "rome.example",
    });
    const storage = makeStorage();
    await saveInstanceOrigin(
      storage,
      "https://cloud.rome.example/dashboard",
      subdomainPolicy,
      "https://cloud.rome.example/login",
    );
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);

    await saveInstanceOrigin(
      storage,
      "https://abc.rome.example/",
      subdomainPolicy,
      "https://cloud.rome.example/dashboard",
    );
    expect(JSON.parse(storage.map.get(INSTANCE_ORIGIN_KEY) ?? "null")).toEqual({
      origin: "https://abc.rome.example",
      romeCloudOrigin: "https://cloud.rome.example",
      instanceDomain: "rome.example",
    });
  });
});

describe("clearInstanceOrigin", () => {
  it("removes the stored origin", async () => {
    const storage = makeStorage({ [INSTANCE_ORIGIN_KEY]: "https://abc.rome.example" });
    await clearInstanceOrigin(storage);
    expect(storage.map.has(INSTANCE_ORIGIN_KEY)).toBe(false);
  });

  it("swallows storage failures", async () => {
    await expect(clearInstanceOrigin(makeThrowingStorage())).resolves.toBeUndefined();
  });
});
