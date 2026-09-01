import { describe, expect, it } from "@rstest/core";
import { CredentialVault, type SecureKeyValueStore } from "./credential-vault.js";

function memoryStore(): SecureKeyValueStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
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

describe("CredentialVault", () => {
  it("stores the Cloud credential and per-origin sessions only in its secure adapter", async () => {
    const store = memoryStore();
    const vault = new CredentialVault(store);
    await vault.setCloudCredential({ accessToken: "cloud-secret", deviceSessionId: "device-1" });
    await vault.setInstanceSession({
      cookieName: "rome_session",
      token: "session-a",
      expiresAt: "2099-01-01T00:00:00.000Z",
      origin: "https://a.romeos.cc",
    });
    await vault.setInstanceSession({
      cookieName: "rome_session",
      token: "session-b",
      expiresAt: "2099-01-01T00:00:00.000Z",
      origin: "https://b.romeos.cc",
    });

    expect(await vault.getCloudCredential()).toEqual({
      accessToken: "cloud-secret",
      deviceSessionId: "device-1",
    });
    expect((await vault.getInstanceSession("https://a.romeos.cc"))?.token).toBe("session-a");
    expect((await vault.getInstanceSession("https://b.romeos.cc"))?.token).toBe("session-b");
    expect([...store.values.keys()]).toEqual(["rome.native.credentials.v1"]);
  });

  it("quarantines a token when remote revocation cannot finish", async () => {
    const store = memoryStore();
    const vault = new CredentialVault(store);
    await vault.setCloudCredential({ accessToken: "cloud-secret", deviceSessionId: "device-1" });
    await vault.quarantineCloudCredential();
    expect(await vault.getCloudCredential()).toBeNull();
    expect([...store.values.values()][0]).toContain("pendingCloudRevocation");
    expect([...store.values.values()][0]).toContain("cloud-secret");
    await vault.setCloudCredential({ accessToken: "new-secret", deviceSessionId: "device-2" });
    expect(await vault.getPendingCloudRevocation()).toEqual({
      accessToken: "cloud-secret",
      deviceSessionId: "device-1",
    });
  });

  it("rejects non-HTTPS instance origins", async () => {
    const vault = new CredentialVault(memoryStore());
    expect(() =>
      vault.setInstanceSession({
        cookieName: "rome_session",
        token: "session",
        expiresAt: "2099-01-01T00:00:00.000Z",
        origin: "http://rome.local",
      }),
    ).toThrow("origin");
  });
});
