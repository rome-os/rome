import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it } from "@rstest/core";
import { WebSocket } from "ws";
import {
  COOKIE_NAME,
  createSession,
  createVisitorSession,
  VISITOR_COOKIE_NAME,
} from "../../access/auth.js";
import { LanNodesRepository } from "../../db/repositories/lan-nodes.js";
import { guardianAuth } from "../../db/schema.js";
import { createLocalLanNodes, withLocalLanNodes } from "../../desktops/local-lan-nodes.js";
import { createNodeDevicesService } from "../../desktops/node-devices.js";
import { createTestDb } from "../../test/db.js";
import { buildTestDeps } from "../../test/helpers.js";
import { startApi } from "../index.js";
import type { ApiHandle } from "../deps.js";

const path = "/api/devices/lan-nodes";
const guardianId = randomUUID();
const userId = "local-guardian";
const verifier = "v".repeat(43);

const headersFor = (user: string) => ({ Cookie: `${COOKIE_NAME}=${createSession(user)}` });
const authorization = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (value: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(value),
});
const databases: Array<ReturnType<typeof createTestDb>> = [];
const apis: ApiHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0))
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  for (const api of apis.splice(0)) await api.close();
  for (const db of databases.splice(0)) db.close();
});

async function database() {
  const db = createTestDb();
  databases.push(db);
  await db.db.insert(guardianAuth).values({
    id: guardianId,
    userId,
    passwordHash: "local-password-hash",
    createdAt: new Date(),
  });
  return db.db;
}

async function server(db: Awaited<ReturnType<typeof database>>) {
  const local = createLocalLanNodes(new LanNodesRepository(db));
  const cloud = createNodeDevicesService(() => ({
    getDevicesStatus: async () => null,
    listDevices: async () => ({ items: [] }),
    run: async () => {
      throw new Error("Unexpected Cloud action");
    },
    renameDevice: async () => {
      throw new Error("Unexpected Cloud rename");
    },
    removeDevice: async () => {
      throw new Error("Unexpected Cloud remove");
    },
    disconnect() {},
  }));
  const devices = withLocalLanNodes(cloud, local);
  const deps = await buildTestDeps(db);
  const api = await startApi(
    { host: "127.0.0.1", port: 0 },
    {
      ...deps,
      nodeDevices: devices,
      localLanNodes: local,
      lanNodes: local.service,
    },
  );
  apis.push(api);
  const origin = `http://127.0.0.1:${api.port}`;
  const owner = { ...headersFor(userId), Origin: origin };
  return { api, devices, owner, origin, local };
}

function deviceSocket(origin: string, token: string) {
  const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws/lan-node", {
    headers: authorization(token),
  });
  sockets.push(socket);
  return socket;
}

it("pairs a local guardian's Node through the normal API and revokes it through device management", async () => {
  const db = await database();
  const { api, owner, origin } = await server(db);
  const url = origin + path;
  const verify = (uri: string) =>
    fetch(origin + "/api/auth/verify", {
      headers: { "X-Forwarded-Uri": uri },
    });
  expect((await verify(path)).status).toBe(401);
  expect((await verify(path + "/redeem")).status).toBe(204);
  expect((await verify("/api/account/devices")).status).toBe(204);
  for (const headers of [
    { Origin: origin },
    { ...headersFor("other-owner"), Origin: origin },
    { ...headersFor(userId), Origin: "https://other.example" },
    {
      Cookie: `${VISITOR_COOKIE_NAME}=${createVisitorSession(userId, "guard@example.com")}`,
      Origin: origin,
    },
  ]) {
    expect((await fetch(url, json({ name: "NAS" }, headers))).status).toBe(403);
  }
  const start = await fetch(url, json({ name: "NAS" }, owner));
  expect(start.status).toBe(201);
  expect(start.headers.get("cache-control")).toBe("no-store");
  const grant = await start.json();
  expect(grant).toMatchObject({
    origin: null,
    installToken: expect.stringMatching(/^romeinstall_/),
  });
  const { installToken } = grant;
  const claim = (proof: string) =>
    fetch(
      `${url}/redeem`,
      json(
        {
          installation_id: grant.id,
          verifier: proof,
        },
        authorization(installToken),
      ),
    );
  expect(await fetch(url, { headers: owner }).then((r) => r.json())).toMatchObject({
    transport: "direct",
    nodes: [{ id: grant.id, status: "waiting" }],
  });
  expect((await fetch(origin + "/v1/gateway/config", { headers: owner })).status).toBe(401);
  const response = await claim(verifier);
  expect(response.status).toBe(200);
  const session = await response.json();
  expect(await claim(verifier).then((r) => r.json())).toEqual(session);
  expect((await claim("w".repeat(43))).status).toBe(409);
  expect((await fetch(`${url}/${grant.id}/pairing`, json({}, owner))).status).toBe(409);
  expect((await fetch(url, { headers: owner }).then((r) => r.json())).nodes[0].status).toBe(
    "offline",
  );
  const credential = authorization(session.access_token);
  expect(
    await fetch(origin + "/v1/gateway/config", {
      headers: { ...credential, "X-Forwarded-Host": "unrelated.example" },
    }).then((r) => r.json()),
  ).toEqual({ gatewayPath: "/ws/lan-node" });
  expect(
    (await fetch(origin + "/api/account/devices", { headers: credential }).then((r) => r.json()))
      .items[0],
  ).toEqual({
    id: session.device_id,
    device_name: "NAS",
    platform: "linux",
    device_kind: "lan_node",
  });
  expect((await fetch(url, { headers: credential })).status).toBe(403);

  const bad = deviceSocket(origin, installToken);
  const [error] = await once(bad, "error");
  expect(error.message).toContain("401");
  const node = deviceSocket(origin, session.access_token);
  await once(node, "open");
  expect((await fetch(url, { headers: owner }).then((r) => r.json())).nodes[0].status).toBe(
    "online",
  );
  const pending = fetch(
    `${url}/${grant.id}/switch-status`,
    json({ address: "192.168.1.42" }, owner),
  );
  const [raw] = await once(node, "message");
  const sent = JSON.parse(raw.toString());
  expect(sent).toMatchObject({
    from: session.caller_id,
    payload: {
      type: "request",
      action: "lan.shelly.switch.status",
      args: { address: "192.168.1.42" },
    },
  });
  node.send(
    JSON.stringify({
      id: sent.id,
      to: "other-instance",
      payload: { type: "response", ok: true, result: { on: false } },
    }),
  );
  node.send(
    JSON.stringify({
      id: sent.id,
      to: session.caller_id,
      payload: { type: "response", ok: true, result: { on: true } },
    }),
  );
  expect(await (await pending).json()).toEqual({ on: true });
  const removePath = `${origin}/api/devices/${session.device_id}`;
  expect((await fetch(removePath, { method: "DELETE", headers: credential })).status).toBe(403);
  expect(
    (
      await fetch(removePath, {
        method: "DELETE",
        headers: { ...owner, Origin: "https://other.example" },
      })
    ).status,
  ).toBe(403);

  apis.splice(apis.indexOf(api), 1);
  await api.close();
  const restarted = await server(db);
  const resumed = deviceSocket(restarted.origin, session.access_token);
  await once(resumed, "open");
  const afterRestart = await fetch(restarted.origin + "/api/devices", {
    headers: restarted.owner,
  }).then((r) => r.json());
  expect(afterRestart.devices).toMatchObject([
    { id: session.device_id, name: "NAS", status: "connected" },
  ]);
  expect((await restarted.devices.runAction(session.device_id, "exec", {})).ok).toBe(false);
  const onClose = once(resumed, "close");
  expect(
    (
      await fetch(`${restarted.origin}/api/devices/${session.device_id}`, {
        method: "DELETE",
        headers: restarted.owner,
      })
    ).status,
  ).toBe(204);
  expect((await onClose)[0]).toBe(4001);
  expect(
    (await fetch(restarted.origin + "/v1/gateway/config", { headers: credential })).status,
  ).toBe(401);
  const list = await fetch(restarted.origin + path, { headers: restarted.owner }).then((r) =>
    r.json(),
  );
  expect(list.nodes[0]).toMatchObject({ status: "needs_pairing", deviceId: null });
  const replacement = await fetch(
    `${restarted.origin}${path}/${grant.id}/pairing`,
    json({}, restarted.owner),
  ).then((r) => r.json());
  expect(replacement.id).toBe(grant.id);
  expect(replacement.installToken).not.toBe(installToken);
}, 15_000);

it("bounds first redemption and recovery separately, and stores only hashes", async () => {
  const repo = new LanNodesRepository(await database());
  const grant = repo.issue(guardianId, { name: "NAS" }, 0);
  if (grant.outcome !== "issued") throw new Error("No grant issued");
  const { id, installToken } = grant;
  expect(repo.redeem(id, installToken, verifier, 600_000).outcome).toBe("expired");
  const first = repo.redeem(id, installToken, verifier, 599_999);
  expect(first.outcome).toBe("redeemed");
  expect(repo.redeem(id, installToken, verifier, 600_001)).toEqual(first);
  expect(repo.redeem(id, installToken, verifier, 1_200_000).outcome).toBe("expired");
  const saved = JSON.stringify(repo.list(guardianId));
  expect(saved).not.toContain(installToken);
  expect(saved).not.toContain(verifier);
  if (first.outcome === "redeemed") expect(saved).not.toContain(first.token);
});
