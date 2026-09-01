import { describe, expect, it, rs } from "@rstest/core";
import { CloudApi } from "./cloud-api.js";
import { CredentialVault, type SecureKeyValueStore } from "./credential-vault.js";
import { InstanceSessionCoordinator } from "./instance-session-coordinator.js";
import type { CloudInstance } from "./native-auth-types.js";
import type { WebViewCookieStore } from "./webview-cookie-store.js";

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

describe("InstanceSessionCoordinator", () => {
  it("shares one in-flight exchange and installs the host-bound session", async () => {
    const calls: string[] = [];
    const fetchImpl = rs.fn(async (raw: string, init?: RequestInit) => {
      const url = new URL(raw);
      calls.push(url.pathname);
      if (url.pathname.endsWith("/native/start")) {
        return Response.json({
          authorization_request: {
            response_type: "code",
            client_id: "rome-instance",
            redirect_uri: "https://my-rome.romeos.cc/api/auth/cloud/callback",
            scope: "openid",
            state: "state-1",
            code_challenge: "challenge-1",
            code_challenge_method: "S256",
            nonce: "nonce-1",
          },
          origin: instance.origin,
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      if (url.pathname.includes("/authorizations")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cloud-token");
        return Response.json({
          code: "one-time-code",
          state: "state-1",
          iss: "https://romeos.cc",
          expires_in: 120,
        });
      }
      if (url.pathname.endsWith("/native/complete")) {
        return Response.json({
          cookie_name: "rome_session",
          session_token: "instance-token",
          expires_at: "2099-01-01T00:00:00.000Z",
          origin: instance.origin,
        });
      }
      throw new Error("unexpected URL");
    });
    const vault = new CredentialVault(memoryStore());
    await vault.setCloudCredential({ accessToken: "cloud-token", deviceSessionId: "device-1" });
    const cookieStore: WebViewCookieStore = { install: rs.fn(), clear: rs.fn() };
    const cloudApi = new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch);
    const coordinator = new InstanceSessionCoordinator(
      cloudApi,
      vault,
      cookieStore,
      fetchImpl as unknown as typeof fetch,
      () => 1_700_000_000_000,
    );

    const [first, second] = await Promise.all([
      coordinator.refresh(instance),
      coordinator.refresh(instance),
    ]);
    expect(first).toEqual(second);
    expect(calls).toEqual([
      "/api/auth/cloud/native/start",
      "/v1/instances/instance-1/authorizations",
      "/api/auth/cloud/native/complete",
    ]);
    expect(await vault.getInstanceSession(instance.origin)).toEqual(first);
    expect(cookieStore.install).toHaveBeenCalledOnce();
  });

  it("rejects a Core response bound to another origin", async () => {
    const fetchImpl = rs.fn(async () =>
      Response.json({
        authorization_request: {
          response_type: "code",
          client_id: "rome-instance",
          redirect_uri: "https://other.romeos.cc/api/auth/cloud/callback",
          scope: "openid",
          state: "state-1",
          code_challenge: "challenge-1",
          code_challenge_method: "S256",
          nonce: "nonce-1",
        },
        origin: "https://other.romeos.cc",
        expires_at: "2099-01-01T00:00:00.000Z",
      }),
    );
    const vault = new CredentialVault(memoryStore());
    await vault.setCloudCredential({ accessToken: "cloud-token", deviceSessionId: "device-1" });
    const coordinator = new InstanceSessionCoordinator(
      new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch),
      vault,
      { install: rs.fn(), clear: rs.fn() },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(coordinator.refresh(instance)).rejects.toThrow("invalid session request");
  });

  it("reports when the selected Rome does not have the Native session routes", async () => {
    const fetchImpl = rs.fn(async () => Response.json({ error: "not_found" }, { status: 404 }));
    const vault = new CredentialVault(memoryStore());
    await vault.setCloudCredential({ accessToken: "cloud-token", deviceSessionId: "device-1" });
    const coordinator = new InstanceSessionCoordinator(
      new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch),
      vault,
      { install: rs.fn(), clear: rs.fn() },
      fetchImpl as unknown as typeof fetch,
    );

    await expect(coordinator.refresh(instance)).rejects.toThrow(
      "This Rome needs an update before Native sign-in",
    );
  });

  it("restarts the complete exchange once when pending state has drifted", async () => {
    let exchange = 0;
    const calls: string[] = [];
    const fetchImpl = rs.fn(async (raw: string) => {
      const path = new URL(raw).pathname;
      calls.push(path);
      if (path.endsWith("/native/start")) {
        exchange += 1;
        return Response.json({
          authorization_request: {
            response_type: "code",
            client_id: "rome-instance",
            redirect_uri: "https://my-rome.romeos.cc/api/auth/cloud/callback",
            scope: "openid",
            state: `state-${exchange}`,
            code_challenge: `challenge-${exchange}`,
            code_challenge_method: "S256",
            nonce: `nonce-${exchange}`,
          },
          origin: instance.origin,
          expires_at: "2099-01-01T00:00:00.000Z",
        });
      }
      if (path.includes("/authorizations")) {
        return Response.json({
          code: `code-${exchange}`,
          state: `state-${exchange}`,
          iss: "https://romeos.cc",
          expires_in: 120,
        });
      }
      if (exchange === 1) return Response.json({ error: "invalid_state" }, { status: 400 });
      return Response.json({
        cookie_name: "rome_session",
        session_token: "instance-token",
        expires_at: "2099-01-01T00:00:00.000Z",
        origin: instance.origin,
      });
    });
    const vault = new CredentialVault(memoryStore());
    await vault.setCloudCredential({ accessToken: "cloud-token", deviceSessionId: "device-1" });
    const coordinator = new InstanceSessionCoordinator(
      new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch),
      vault,
      { install: rs.fn(), clear: rs.fn() },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(coordinator.refresh(instance)).resolves.toMatchObject({ token: "instance-token" });
    expect(calls.filter((path) => path.endsWith("/native/start"))).toHaveLength(2);
    expect(calls.filter((path) => path.endsWith("/native/complete"))).toHaveLength(2);
  });
});
