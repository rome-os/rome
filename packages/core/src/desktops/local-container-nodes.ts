import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { DevicesStatus } from "@rome/api-types/devices";
import { isRecord, parseResponse } from "@rome-os/node-core";
import { CONTAINER_NODE_SOCKET_PATH } from "@rome-os/node-core/container-node-address";
import { isLoopbackHostname } from "@rome-os/libs/net";
import { v5 as uuidv5 } from "uuid";
import { WebSocket, WebSocketServer } from "ws";
import type { ContainerNodesRepository } from "../db/repositories/container-nodes.js";
import { deriveInstanceOrigin } from "../instance/instance-env.js";
import { rejectUpgrade } from "../lib/ws-upgrade.js";
import type { DeviceRunResult } from "./node-devices.js";

const switchAction = "shelly.switch.status";
const callerId = (guardianId: string) => uuidv5(`rome-container-node:${guardianId}`, uuidv5.URL);
const offline = {
  ok: false,
  code: "target_unavailable",
  message: "The container node is offline.",
} as const;

interface Connection {
  socket: WebSocket;
  pending: Map<string, (result: DeviceRunResult) => void>;
}

export function createLocalContainerNodes(repo: ContainerNodesRepository, env = process.env) {
  // Adoption can assign a slug at runtime. The hosting domain stays fixed.
  const hostedOrigin = URL.parse(deriveInstanceOrigin("probe", env) ?? "");
  if (hostedOrigin && !isLoopbackHostname(hostedOrigin.hostname)) return;

  const connections = new Map<string, Connection>();
  const findByBearer = (header?: string) => {
    const token = /^Bearer (romedev_[A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    return token ? repo.findByToken(token) : undefined;
  };
  const deviceOwner = (id: string) => repo.findByDeviceId(id)?.guardianId;

  function closeDevice(id: string, code: number) {
    const connection = connections.get(id);
    if (!connection) return;
    connections.delete(id);
    for (const finish of connection.pending.values()) finish(offline);
    connection.socket.close(code);
  }

  function attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (req.url?.split("?")[0] !== CONTAINER_NODE_SOCKET_PATH) return;
      socket.on("error", () => socket.destroy());
      try {
        const row =
          req.url === CONTAINER_NODE_SOCKET_PATH && req.headers.origin === undefined
            ? findByBearer(req.headers.authorization)
            : undefined;
        if (!row?.deviceId) return rejectUpgrade(socket, 401, "Unauthorized");
        const deviceId = row.deviceId;
        const from = callerId(row.guardianId);
        wss.handleUpgrade(req, socket, head, (ws) => {
          req.socket.setKeepAlive(true, 30_000);
          closeDevice(deviceId, 4002);
          const connection: Connection = { socket: ws, pending: new Map() };
          connections.set(deviceId, connection);
          ws.on("error", () => ws.terminate());
          ws.once("close", () => {
            if (connections.get(deviceId) === connection) connections.delete(deviceId);
            for (const finish of connection.pending.values()) finish(offline);
          });
          ws.on("message", (data, binary) => {
            // Only a reply to a request sent on this authenticated socket can complete it.
            if (binary || connections.get(deviceId) !== connection) return;
            let packet: unknown;
            try {
              packet = JSON.parse(data.toString());
            } catch {
              return;
            }
            if (!isRecord(packet) || packet.to !== from || typeof packet.id !== "string") return;
            const finish = connection.pending.get(packet.id);
            if (!finish) return;
            const payload = parseResponse(packet.payload);
            if (payload)
              finish(
                payload.ok ? { ok: true, result: payload.result } : { ok: false, ...payload.error },
              );
          });
        });
      } catch {
        rejectUpgrade(socket, 503, "Service Unavailable");
      }
    };
    server.on("upgrade", onUpgrade);
    return {
      close() {
        server.off("upgrade", onUpgrade);
        for (const socket of wss.clients) socket.terminate();
        wss.close();
      },
    };
  }

  async function run(deviceId: string, action: string, args: unknown): Promise<DeviceRunResult> {
    if (action !== "system.info" && action !== switchAction) {
      return {
        ok: false,
        code: "unsupported_action",
        message: "This action is unavailable on a container node.",
      };
    }
    const connection = connections.get(deviceId);
    const owner = deviceOwner(deviceId);
    if (!owner || connection?.socket.readyState !== WebSocket.OPEN) return offline;
    if (connection.pending.size >= 8)
      return {
        ok: false,
        code: "node_busy",
        message: "A container node request is already running.",
      };
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (result: DeviceRunResult) => {
        clearTimeout(timeout);
        connection.pending.delete(id);
        resolve(result);
      };
      const timeout = setTimeout(
        () =>
          finish({
            ok: false,
            code: "timeout",
            message: "The container node did not answer.",
          }),
        6000,
      );
      connection.pending.set(id, finish);
      try {
        connection.socket.send(
          JSON.stringify({
            id,
            from: callerId(owner),
            payload: { type: "request", action, args },
          }),
          (error) => {
            if (error) finish(offline);
          },
        );
      } catch {
        finish(offline);
      }
    });
  }

  return {
    attach,
    findByBearer,
    deviceOwner,
    run,
    list(guardianId: string): DevicesStatus["devices"] {
      return repo
        .list(guardianId)
        .flatMap(({ deviceId, name }) =>
          deviceId
            ? [{ id: deviceId, name, platform: "linux", status: "unknown", kind: "container_node" }]
            : [],
        );
    },
    issue(guardianId: string, name: string, origin: string) {
      return { ...repo.create(guardianId, name), origin, callerId: callerId(guardianId) };
    },
    rename(guardianId: string, deviceId: string, name: string) {
      return repo.rename(guardianId, deviceId, name);
    },
    remove(guardianId: string, deviceId: string) {
      if (!repo.remove(guardianId, deviceId)) return false;
      closeDevice(deviceId, 4001);
      return true;
    },
  };
}

export type LocalContainerNodes = NonNullable<ReturnType<typeof createLocalContainerNodes>>;
