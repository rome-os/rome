import { describe, expect, it, rs } from "@rstest/core";
import type { CloudApi } from "./cloud-api.js";
import { CredentialVault, type SecureKeyValueStore } from "./credential-vault.js";
import { logoutNativeSession, retryPendingCloudRevocation } from "./native-logout.js";

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

describe("Native logout", () => {
  it("clears Native sessions, WebView cookies, and selection after revocation", async () => {
    const vault = new CredentialVault(memoryStore());
    await vault.setCloudCredential({ accessToken: "cloud-token", deviceSessionId: "device-1" });
    await vault.setInstanceSession({
      cookieName: "rome_session",
      token: "instance-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      origin: "https://my-rome.romeos.cc",
    });
    const clearCookie = rs.fn(async () => undefined);
    const clearSelection = rs.fn(async () => undefined);
    await logoutNativeSession({
      cloudApi: { revoke: rs.fn(async () => true) } as unknown as CloudApi,
      vault,
      cookieStore: { install: rs.fn(), clear: clearCookie },
      clearSelection,
    });
    expect(await vault.getCloudCredential()).toBeNull();
    expect(await vault.getInstanceOrigins()).toEqual([]);
    expect(clearCookie).toHaveBeenCalledWith("https://my-rome.romeos.cc");
    expect(clearSelection).toHaveBeenCalledOnce();
  });

  it("quarantines and later retries a credential when Cloud is offline", async () => {
    const vault = new CredentialVault(memoryStore());
    await vault.setCloudCredential({ accessToken: "cloud-token", deviceSessionId: "device-1" });
    await logoutNativeSession({
      cloudApi: {
        revoke: rs.fn(async () => Promise.reject(new Error("offline"))),
      } as unknown as CloudApi,
      vault,
      cookieStore: { install: rs.fn(), clear: rs.fn() },
      clearSelection: rs.fn(),
    });
    expect(await vault.getCloudCredential()).toBeNull();
    expect(await vault.getPendingCloudRevocation()).toEqual({
      accessToken: "cloud-token",
      deviceSessionId: "device-1",
    });

    const revoke = rs.fn(async () => true);
    await retryPendingCloudRevocation({ revoke } as unknown as CloudApi, vault);
    expect(revoke).toHaveBeenCalledWith({
      accessToken: "cloud-token",
      deviceSessionId: "device-1",
    });
    expect(await vault.getPendingCloudRevocation()).toBeNull();
  });
});
