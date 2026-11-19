import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { Hono } from "hono";
import {
  COOKIE_NAME,
  createSession,
  createVisitorSession,
  VISITOR_COOKIE_NAME,
} from "../../access/auth.js";
import { createCloudGuardian, setGuardianAccount } from "../../access/guardian-auth-state.js";
import { createLanNodesService } from "../../desktops/lan-nodes.js";
import { proveIdentity } from "../../instance/instance-identity.js";
import { createTestDb } from "../../test/db.js";
import { lanNodesRoutes } from "./lan-nodes.js";

const path = "/api/devices/lan-nodes";
const id = "3dc4a001-183f-4170-b150-1e2c0c792d72";
const deviceId = "28f6417c-1167-4f52-9d25-e28d07804a78";
const owner = "cloud-owner";
const instanceId = "test-instance";
const bearer = "romeinst_test";
const cloudPath = "/api/instance/lan-nodes";
const cloud = {
  origin: () => "https://cloud.example",
  bearer: async () => bearer,
  prove: proveIdentity,
};
const installToken = `romeinstall_${"A".repeat(43)}`;
const expiry = () => new Date(Date.now() + 10 * 60_000).toISOString();
const guard = (user = owner) => ({ Cookie: `${COOKIE_NAME}=${createSession(user)}` });
function post(body: unknown, headers = guard()): RequestInit {
  return {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify(body),
  };
}

describe("LAN Node device settings", () => {
  let db: ReturnType<typeof createTestDb>;
  let app: Hono;
  let cloudAccount: string;
  let upstream: (url: string, init?: RequestInit) => Response;
  const runAction = rs.fn(async () => ({
    ok: true as const,
    result: { on: true, ignored: "raw" },
  }));
  const getStatus = rs.fn();

  beforeEach(async () => {
    db = createTestDb();
    await createCloudGuardian(db.db, owner);
    cloudAccount = owner;
    upstream = () => Response.json({ error: "unexpected" }, { status: 500 });
    rs.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.origin).toBe("https://cloud.example");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${bearer}`);
      if (url.pathname === "/api/instance/whoami")
        return Response.json({ instanceId, account: { id: cloudAccount } });
      return upstream(url.pathname, init);
    });
    getStatus.mockResolvedValue({ connection: "online", devices: [] });
    app = new Hono().route(
      path,
      lanNodesRoutes({
        db: db.db,
        lanNodes: createLanNodesService({ getStatus, runAction }, cloud),
      }),
    );
  });

  afterEach(() => {
    db.close();
    rs.restoreAllMocks();
    rs.clearAllMocks();
  });

  it("requires the signed owner, same-origin writes, and the live instance binding", async () => {
    expect((await app.request(path)).status).toBe(403);
    expect(
      (
        await app.request(path, {
          headers: {
            Cookie: `${VISITOR_COOKIE_NAME}=${createVisitorSession(owner, "owner@example.com")}`,
          },
        })
      ).status,
    ).toBe(403);
    expect((await app.request(path, post({ name: "NAS" }, guard("former-owner")))).status).toBe(
      403,
    );
    expect(
      (
        await app.request(path, {
          ...post({ name: "NAS" }),
          headers: { ...guard(), Origin: "https://different.example" },
        })
      ).status,
    ).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    cloudAccount = "other-account";
    expect((await app.request(path, post({ name: "NAS" }))).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    await setGuardianAccount(db.db, "other-account");
    expect(
      (await app.request(`${path}/${id}/switch-status`, post({ address: "192.168.1.2" }))).status,
    ).toBe(403);
    expect(runAction).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the validated Cloud grant and origin without caching it", async () => {
    const expiresAt = expiry();
    upstream = (url, init) => {
      expect(init?.method).toBe("POST");
      if (url === cloudPath) expect(JSON.parse(String(init?.body))).toEqual({ name: "My NAS" });
      else {
        expect(url).toBe(`${cloudPath}/${id}/pairing`);
        expect(JSON.parse(String(init?.body))).toEqual({});
      }
      return Response.json({ id, expiresAt, installToken, instanceId }, { status: 201 });
    };
    const first = await app.request(path, post({ name: " My NAS " }));
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const grant = { id, expiresAt, installToken, origin: "https://cloud.example" };
    expect(await first.json()).toEqual(grant);
    const replaced = await app.request(`${path}/${id}/pairing`, post({}));
    expect(replaced.status).toBe(201);
    expect(await replaced.json()).toEqual(grant);
  });

  it("removes an installation only after proving the Cloud account binding", async () => {
    const remove = () =>
      app.request(`${path}/${id}`, {
        method: "DELETE",
        headers: { ...guard(), Origin: "http://localhost" },
      });
    upstream = (url, init) => {
      expect(url).toBe(`${cloudPath}/${id}`);
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    };
    cloudAccount = "other-account";
    expect((await remove()).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
    cloudAccount = owner;
    expect((await remove()).status).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("combines grant and Gateway status without treating unavailable probes as offline", async () => {
    upstream = () =>
      Response.json({
        instanceId,
        nodes: [
          { id, name: "NAS", state: "paired", deviceId },
          {
            id: "3dc4a001-183f-4170-b150-1e2c0c792d73",
            name: "New",
            state: "pending",
            expiresAt: expiry(),
          },
          {
            id: "3dc4a001-183f-4170-b150-1e2c0c792d74",
            name: "Expired",
            state: "pending",
            expiresAt: new Date(0).toISOString(),
          },
          { id: "3dc4a001-183f-4170-b150-1e2c0c792d75", name: "Removed", state: "needs_pairing" },
        ],
      });
    const read = async () => (await app.request(path, { headers: guard() })).json();
    expect((await read()).transport).toBe("cloud");
    expect((await read()).nodes.map((node: { status: string }) => node.status)).toEqual([
      "unknown",
      "waiting",
      "needs_pairing",
      "needs_pairing",
    ]);
    for (const [status, expected] of [
      ["connected", "online"],
      ["not_connected", "offline"],
      ["revoked", "needs_pairing"],
    ]) {
      getStatus.mockResolvedValue({ devices: [{ id: deviceId, name: "Renamed NAS", status }] });
      expect((await read()).nodes[0]).toEqual({
        id,
        deviceId,
        name: "Renamed NAS",
        status: expected,
      });
    }
  });

  it("checks only a paired device from the authenticated instance's installation list", async () => {
    const check = (nodeId: string, body: unknown) =>
      app.request(`${path}/${nodeId}/switch-status`, post(body));
    const nodes = [{ id, name: "NAS", state: "paired", deviceId }];
    upstream = () => Response.json({ instanceId: "sibling-instance", nodes });
    expect((await check(id, { address: "192.168.1.4" })).status).toBe(503);
    upstream = () => Response.json({ instanceId, nodes });
    expect((await check(deviceId, { address: "192.168.1.4" })).status).toBe(404);
    expect((await check(id, { address: "192.168.1.4", deviceId })).status).toBe(400);
    expect(runAction).not.toHaveBeenCalled();
    const response = await check(id, { address: "192.168.1.4" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ on: true });
    expect(runAction).toHaveBeenCalledWith(deviceId, "lan.shelly.switch.status", {
      address: "192.168.1.4",
    });
  });

  it("fails closed when Cloud does not implement the installer", async () => {
    upstream = () => new Response("upstream 404", { status: 404 });
    const response = await app.request(path, { headers: guard() });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({ error: "cloud_unsupported" });
  });
});
