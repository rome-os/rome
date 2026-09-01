import { describe, expect, it, rs } from "@rstest/core";
import { CredentialVault, type SecureKeyValueStore } from "./credential-vault.js";
import type { InstanceSessionCoordinator } from "./instance-session-coordinator.js";
import type { CloudInstance, InstanceSession } from "./native-auth-types.js";
import { RomeApiClient } from "./rome-api-client.js";

const instance: CloudInstance = {
  id: "instance-1",
  name: "My Rome",
  slug: "my-rome",
  origin: "https://my-rome.romeos.cc",
  status: "running",
};

function memoryStore(): SecureKeyValueStore {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async deleteItem(key) {
      values.delete(key);
    },
  };
}

function session(token: string): InstanceSession {
  return {
    cookieName: "rome_session",
    token,
    expiresAt: "2099-01-01T00:00:00.000Z",
    origin: instance.origin,
  };
}

describe("RomeApiClient", () => {
  it("injects the selected origin session and retries one 401", async () => {
    const vault = new CredentialVault(memoryStore());
    await vault.setInstanceSession(session("old-token"));
    const refresh = rs.fn(async () => {
      const next = session("new-token");
      await vault.setInstanceSession(next);
      return next;
    });
    const seen: string[] = [];
    const fetchImpl = rs.fn(async (url: string, init?: RequestInit) => {
      expect(new URL(url).origin).toBe(instance.origin);
      seen.push(new Headers(init?.headers).get("cookie") ?? "");
      return new Response(null, { status: seen.length === 1 ? 401 : 204 });
    });
    const client = new RomeApiClient(
      instance,
      vault,
      { refresh } as unknown as InstanceSessionCoordinator,
      fetchImpl as unknown as typeof fetch,
    );
    expect((await client.request("/api/auth/verify")).status).toBe(204);
    expect(seen).toEqual(["rome_session=old-token", "rome_session=new-token"]);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not refresh a 403", async () => {
    const vault = new CredentialVault(memoryStore());
    await vault.setInstanceSession(session("token"));
    const refresh = rs.fn();
    const client = new RomeApiClient(
      instance,
      vault,
      { refresh } as unknown as InstanceSessionCoordinator,
      rs.fn(async () => new Response(null, { status: 403 })) as unknown as typeof fetch,
    );
    expect((await client.request("/api/private")).status).toBe(403);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("rejects absolute, non-API, cross-origin, and caller-authenticated requests", async () => {
    const vault = new CredentialVault(memoryStore());
    await vault.setInstanceSession(session("token"));
    const client = new RomeApiClient(
      instance,
      vault,
      { refresh: rs.fn() } as unknown as InstanceSessionCoordinator,
      rs.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch,
    );
    await expect(client.request("https://romeos.cc/api/account")).rejects.toThrow("relative /api");
    await expect(client.request("/settings")).rejects.toThrow("relative /api");
    await expect(
      client.request("/api/private", { headers: { Cookie: "rome_session=caller-token" } }),
    ).rejects.toThrow("authentication headers");
    await expect(client.asFetch()("https://other.romeos.cc/api/private")).rejects.toThrow(
      "unselected origin",
    );
  });
});
