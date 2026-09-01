import { describe, expect, it, rs } from "@rstest/core";
import { CloudApi } from "./cloud-api.js";

const credential = { accessToken: "cloud-token", deviceSessionId: "device-1" };

describe("CloudApi", () => {
  it("takes selectable origins only from a valid Cloud response", async () => {
    const fetchImpl = rs.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer cloud-token");
      return Response.json({
        items: [
          {
            id: "instance-1",
            name: "My Rome",
            slug: "my-rome",
            origin: "https://my-rome.romeos.cc",
            status: "running",
          },
        ],
      });
    });
    const api = new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch);
    expect(await api.listInstances(credential)).toEqual([
      {
        id: "instance-1",
        name: "My Rome",
        slug: "my-rome",
        origin: "https://my-rome.romeos.cc",
        status: "running",
      },
    ]);
  });

  it("rejects malformed, insecure, and Cloud-reusing service origins", async () => {
    for (const origin of [
      "http://my-rome.romeos.cc",
      "https://romeos.cc",
      "https://a.romeos.cc/path",
    ]) {
      const fetchImpl = rs.fn(async () =>
        Response.json({
          items: [{ id: "1", name: "Rome", slug: "rome", origin, status: "running" }],
        }),
      );
      const api = new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch);
      await expect(api.listInstances(credential)).rejects.toThrow();
    }
  });

  it("surfaces a revoked Cloud device credential without returning secrets", async () => {
    const api = new CloudApi(
      "https://romeos.cc",
      rs.fn(async () =>
        Response.json({ error: "unauthorized" }, { status: 401 }),
      ) as unknown as typeof fetch,
    );
    await expect(api.listInstances(credential)).rejects.toMatchObject({
      code: "cloud_unauthorized",
      message: "The Rome Cloud session has expired",
    });
  });

  it("reports authorization drift so the Launcher can reload its service list", async () => {
    const api = new CloudApi(
      "https://romeos.cc",
      rs.fn(async () =>
        Response.json({ error: "access_denied" }, { status: 403 }),
      ) as unknown as typeof fetch,
    );
    await expect(
      api.createInstanceAuthorization(
        {
          id: "instance-1",
          name: "My Rome",
          slug: "my-rome",
          origin: "https://my-rome.romeos.cc",
          status: "running",
        },
        {
          response_type: "code",
          client_id: "rome-instance",
          redirect_uri: "https://my-rome.romeos.cc/api/auth/cloud/callback",
          scope: "openid",
          state: "state-1",
          code_challenge: "challenge-1",
          code_challenge_method: "S256",
          nonce: "nonce-1",
        },
        credential,
      ),
    ).rejects.toMatchObject({ code: "access_denied" });
  });
});
