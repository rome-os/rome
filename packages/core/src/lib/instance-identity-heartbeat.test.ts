import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { runInstanceIdentityHeartbeatTick } from "./instance-identity-heartbeat.js";
import {
  getInstanceToken,
  setInstanceTokenInMemory,
  type ProveIdentityResult,
} from "./instance-identity.js";

const TOKEN = "romeinst_heartbeat";
const SETTING_KEY = "instanceToken";

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

const prove = (status: ProveIdentityResult["status"]) =>
  rs.fn(async () =>
    status === "ok"
      ? ({ status: "ok", identity: { accountId: "a", instanceId: "i" } } as ProveIdentityResult)
      : ({ status } as ProveIdentityResult),
  );

describe("runInstanceIdentityHeartbeatTick", () => {
  afterEach(() => setInstanceTokenInMemory(null));

  it("does nothing (no network call) when the instance is not enrolled", async () => {
    setInstanceTokenInMemory(null);
    const store = memoryStore();
    const proveFn = prove("revoked");

    await runInstanceIdentityHeartbeatTick({ store, prove: proveFn });

    expect(proveFn).not.toHaveBeenCalled();
  });

  it("keeps the credential when Rome Cloud confirms identity (ok)", async () => {
    setInstanceTokenInMemory(TOKEN);
    const store = memoryStore({ instanceToken: TOKEN });

    await runInstanceIdentityHeartbeatTick({ store, prove: prove("ok") });

    expect(getInstanceToken()).toBe(TOKEN);
    expect(store.data.has(SETTING_KEY)).toBe(true);
  });

  it.each([
    "revoked",
    "unknown",
  ] as const)("clears the credential (DB + cache) on a terminal %s signal", async (status) => {
    setInstanceTokenInMemory(TOKEN);
    const store = memoryStore({ instanceToken: TOKEN });

    await runInstanceIdentityHeartbeatTick({ store, prove: prove(status) });

    expect(getInstanceToken()).toBeNull();
    expect(store.data.has(SETTING_KEY)).toBe(false);
  });

  it.each([
    "unreachable",
    "unconfigured",
  ] as const)("keeps the credential on a non-terminal %s signal", async (status) => {
    setInstanceTokenInMemory(TOKEN);
    const store = memoryStore({ instanceToken: TOKEN });

    await runInstanceIdentityHeartbeatTick({ store, prove: prove(status) });

    expect(getInstanceToken()).toBe(TOKEN);
    expect(store.data.has(SETTING_KEY)).toBe(true);
  });
});
