import { describe, expect, it, rs } from "@rstest/core";
import { CloudApi } from "./cloud-api.js";

const credential = { accessToken: "cloud-token", deviceSessionId: "device-1" };
const owned = {
  id: "instance-1",
  name: "My Rome",
  slug: "my-rome",
  origin: "https://my-rome.romeos.cc",
  status: "running",
};
const shared = {
  id: "instance-2",
  name: "team",
  slug: "team",
  origin: "https://team.romeos.cc",
  status: "running",
};
const ownerRequest = {
  response_type: "code",
  client_id: "rome-instance",
  redirect_uri: "https://my-rome.romeos.cc/api/auth/cloud/callback",
  scope: "openid",
  state: "state-1",
  code_challenge: "challenge-1",
  code_challenge_method: "S256",
  nonce: "nonce-1",
} as const;

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
        role: "owner",
      },
    ]);
  });

  it("keeps whether each Rome is the account's own or shared with it", async () => {
    const fetchImpl = rs.fn(async () =>
      Response.json({
        items: [
          { ...owned, role: "owner" },
          { ...shared, role: "visitor", ownerName: "Dev User" },
        ],
      }),
    );
    const api = new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch);
    expect(await api.listInstances(credential)).toEqual([
      { ...owned, role: "owner" },
      { ...shared, role: "visitor", ownerName: "Dev User" },
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
    for (const status of [403, 404]) {
      const api = new CloudApi(
        "https://romeos.cc",
        rs.fn(async () =>
          Response.json({ error: "instance_not_found" }, { status }),
        ) as unknown as typeof fetch,
      );
      await expect(
        api.createInstanceAuthorization({ ...owned, role: "owner" }, ownerRequest, credential),
      ).rejects.toMatchObject({ code: "access_denied" });
    }
  });

  it("says when Rome Cloud rate-limits sign-in", async () => {
    const api = new CloudApi(
      "https://romeos.cc",
      rs.fn(async () =>
        Response.json({ error: "rate_limit_exceeded" }, { status: 429 }),
      ) as unknown as typeof fetch,
    );
    await expect(
      api.createInstanceAuthorization({ ...owned, role: "owner" }, ownerRequest, credential),
    ).rejects.toMatchObject({ message: "Too many sign-in attempts. Try again in a minute." });
  });

  it("asks the visitor grant for a visitor's code", async () => {
    const request = {
      redirect_uri: "https://team.romeos.cc/api/auth/visitor/callback",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      state: "state-1",
      instance_name: "team",
      intent: "signin",
    } as const;
    const fetchImpl = rs.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://romeos.cc/v1/instances/instance-2/visitor-authorizations");
      expect(JSON.parse(String(init?.body))).toEqual({ authorization_request: request });
      return Response.json({
        code: "code-1",
        state: "state-1",
        iss: "https://romeos.cc",
        expires_in: 60,
      });
    });
    const api = new CloudApi("https://romeos.cc", fetchImpl as unknown as typeof fetch);
    expect(
      await api.createVisitorAuthorization({ ...shared, role: "visitor" }, request, credential),
    ).toEqual({ code: "code-1", state: "state-1", iss: "https://romeos.cc", expires_in: 60 });
  });
});
