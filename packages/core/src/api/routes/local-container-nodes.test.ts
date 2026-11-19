import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it } from "@rstest/core";
import { WebSocket } from "ws";
import { COOKIE_NAME, createSession } from "../../access/auth.js";
import { ContainerNodesRepository } from "../../db/repositories/container-nodes.js";
import { containerNodeInstallations, guardianAuth } from "../../db/schema.js";
import { createLocalContainerNodes } from "../../desktops/local-container-nodes.js";
import { createTestDb } from "../../test/db.js";
import { buildTestDeps } from "../../test/helpers.js";
import { startApi } from "../index.js";
import type { ApiHandle } from "../deps.js";

const path = "/api/devices/container-nodes";
const guardianId = randomUUID();
const userId = "local-guardian";
const cookie = `${COOKIE_NAME}=${createSession(userId)}`;
const databases: Array<ReturnType<typeof createTestDb>> = [];
const apis: ApiHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const api of apis.splice(0)) await api.close();
  for (const db of databases.splice(0)) db.close();
});

async function start(db: ReturnType<typeof createTestDb>) {
  const local = createLocalContainerNodes(new ContainerNodesRepository(db.db), {});
  const deps = await buildTestDeps(db.db);
  const api = await startApi(
    { host: "127.0.0.1", port: 0 },
    { ...deps, localContainerNodes: local },
  );
  apis.push(api);
  const origin = `http://127.0.0.1:${api.port}`;
  const owner = { Cookie: cookie, Origin: origin };
  return { origin, owner, api };
}

it("only offers direct nodes on self-hosted instances", () => {
  const db = createTestDb();
  databases.push(db);
  const repo = new ContainerNodesRepository(db.db);
  expect(createLocalContainerNodes(repo, { PANTHEON_DOMAIN: "romeos.cc" })).toBeUndefined();
  expect(createLocalContainerNodes(repo, { PANTHEON_DOMAIN: "localhost" })).toBeDefined();
});

it("issues immediately, keeps the device across a restart, and revokes the receiver", async () => {
  const db = createTestDb();
  databases.push(db);
  await db.db.insert(guardianAuth).values({
    id: guardianId,
    userId,
    passwordHash: "local-password-hash",
    createdAt: new Date(),
  });
  const first = await start(db);
  const issue = (origin: string, headers = first.owner) =>
    fetch(first.origin + path, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "NAS", origin }),
    });
  expect((await issue("http://public.example")).status).toBe(400);
  expect((await issue(first.origin, { ...first.owner, Cookie: "" })).status).toBe(403);
  const issued = await issue(first.origin);
  expect(issued.status).toBe(201);
  expect(issued.headers.get("cache-control")).toBe("no-store");
  const { deviceId, deviceToken, callerId } = await issued.json();
  const row = db.db.select().from(containerNodeInstallations).get();
  expect(row?.deviceId).toBe(deviceId);
  expect(row?.tokenHash).toBe(createHash("sha256").update(deviceToken).digest("hex"));
  expect(row?.grantHash).toBeNull();

  apis.splice(apis.indexOf(first.api), 1);
  await first.api.close();
  const { origin, owner } = await start(db);
  const authorization = { Authorization: `Bearer ${deviceToken}` };
  const config = origin + "/v1/gateway/config";
  expect((await fetch(config)).status).toBe(401);
  const configuration = await fetch(config, { headers: authorization });
  expect(configuration.status).toBe(200);
  expect(await configuration.json()).toEqual({ gatewayPath: "/ws/container-node" });
  expect((await fetch(origin + path, { method: "POST", headers: authorization })).status).toBe(403);
  expect((await fetch(origin + `${path}/redeem`, { method: "POST", headers: owner })).status).toBe(
    404,
  );

  const list = async (headers: Record<string, string>) =>
    (await fetch(origin + "/api/devices", { headers })).json();
  const before = await list(owner);
  expect(before.containerNodeTransport).toBe("direct");
  expect(before.devices).toEqual([
    { id: deviceId, name: "NAS", platform: "linux", status: "unknown", kind: "container_node" },
  ]);
  expect((await list(authorization)).devices).toEqual([]);

  const socket = new WebSocket(origin.replace("http:", "ws:") + "/ws/container-node", {
    headers: authorization,
  });
  sockets.push(socket);
  await once(socket, "open");
  socket.once("message", (raw) => {
    const request = JSON.parse(raw.toString());
    expect(request).toMatchObject({ from: callerId, payload: { action: "shelly.switch.status" } });
    socket.send(
      JSON.stringify({
        id: request.id,
        to: request.from,
        payload: { type: "response", ok: true, result: { on: true } },
      }),
    );
  });
  const status = await fetch(origin + `${path}/${deviceId}/switch-status`, {
    method: "POST",
    headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify({ address: "192.168.1.5" }),
  });
  expect(status.status).toBe(200);
  expect(await status.json()).toEqual({ on: true });

  const device = origin + `/api/devices/${deviceId}`;
  expect((await fetch(device, { method: "DELETE", headers: authorization })).status).toBe(403);
  const renamed = await fetch(device, {
    method: "PATCH",
    headers: { ...owner, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Renamed NAS" }),
  });
  expect(renamed.status).toBe(204);
  expect((await list(owner)).devices[0].name).toBe("Renamed NAS");
  const closed = once(socket, "close");
  expect((await fetch(device, { method: "DELETE", headers: owner })).status).toBe(204);
  expect((await closed)[0]).toBe(4001);
  expect((await fetch(config, { headers: authorization })).status).toBe(401);
  expect((await list(owner)).devices).toEqual([]);
});
