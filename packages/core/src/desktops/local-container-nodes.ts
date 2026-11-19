import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import {
  containerNodeNameSchema,
  type DevicesStatus,
  type ContainerNode,
} from "@rome/api-types/devices";
import { isRecord, parseResponse } from "@rome-os/node-core";
import {
  containerNodeOrigin,
  CONTAINER_NODE_SOCKET_PATH,
} from "@rome-os/node-core/container-node-address";
import { createFileCredentialStore } from "@rome-os/node-core/host";
import { isLoopbackHostname } from "@rome-os/libs/net";
import { v5 as uuidv5 } from "uuid";
import { WebSocket, WebSocketServer } from "ws";
import type { ContainerNodesRepository } from "../db/repositories/container-nodes.js";
import { deriveInstanceOrigin } from "../instance/instance-env.js";
import { rejectUpgrade } from "../lib/ws-upgrade.js";
import { getProfileDir } from "../paths.js";
import {
  ContainerNodeError,
  shellySwitchStatus,
  type ContainerNodesService,
} from "./container-nodes.js";
import type {
  createNodeDevicesService,
  DeviceManageResult,
  DeviceRunResult,
} from "./node-devices.js";

const switchAction = "shelly.switch.status";
const callerId = (guardianId: string) => uuidv5(`rome-container-node:${guardianId}`, uuidv5.URL);
const offline = {
  ok: false,
  code: "target_unavailable",
  message: "The container node is offline.",
} as const;

interface Connection {
  socket: WebSocket;
  alive: boolean;
  pending: Map<string, (result: DeviceRunResult) => void>;
}

function createComposeKeyLoader() {
  const store = createFileCredentialStore<string>(
    join(getProfileDir(), "container-node", "install-key.json"),
  );
  let key: Promise<Buffer> | undefined;
  return () =>
    (key ??= (async () => {
      const stored = await store.load();
      if (typeof stored === "string" && /^[A-Za-z0-9_-]{43}$/.test(stored))
        return Buffer.from(stored, "base64url");
      const created = randomBytes(32);
      await store.save(created.toString("base64url"));
      return created;
    })().catch((error) => {
      key = undefined;
      throw error;
    }));
}

export function createLocalContainerNodes(
  repo: ContainerNodesRepository,
  env = process.env,
  composeKey?: () => Promise<Buffer>,
) {
  // Adoption can assign a slug at runtime. The hosting domain stays fixed.
  const hostedOrigin = URL.parse(deriveInstanceOrigin("probe", env) ?? "");
  if (hostedOrigin && !isLoopbackHostname(hostedOrigin.hostname)) return;
  const loadComposeKey = composeKey ?? createComposeKeyLoader();

  const connections = new Map<string, Connection>();
  const findByBearer = (header?: string) => {
    const token = /^Bearer (romedev_[A-Za-z0-9_-]{43})$/.exec(header ?? "")?.[1];
    return token ? repo.findByToken(token) : undefined;
  };
  const online = (id: string) => connections.get(id)?.socket.readyState === WebSocket.OPEN;
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
          closeDevice(deviceId, 4002);
          const connection: Connection = { socket: ws, alive: true, pending: new Map() };
          connections.set(deviceId, connection);
          ws.on("pong", () => {
            connection.alive = true;
          });
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
    const heartbeat = setInterval(() => {
      for (const connection of connections.values()) {
        if (!connection.alive) connection.socket.terminate();
        else if (connection.socket.readyState === WebSocket.OPEN) {
          connection.alive = false;
          connection.socket.ping();
        }
      }
    }, 15_000).unref();
    return {
      close() {
        clearInterval(heartbeat);
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

  const service: ContainerNodesService = {
    async list(guardianId) {
      return {
        nodes: repo.list(guardianId).map(
          (row): ContainerNode => ({
            id: row.id,
            name: row.name,
            deviceId: row.deviceId,
            status: row.deviceId
              ? online(row.deviceId)
                ? "online"
                : "offline"
              : (row.expiresAt ?? 0) > Date.now()
                ? "waiting"
                : "needs_pairing",
          }),
        ),
      };
    },
    async pair(guardianId, input) {
      let origin: string | null = null;
      if (input.origin !== undefined) {
        try {
          origin = containerNodeOrigin(input.origin.trim());
        } catch {
          throw new ContainerNodeError("invalid_origin");
        }
      }
      const result = repo.issue(
        guardianId,
        input,
        Date.now(),
        origin ? { origin, key: await loadComposeKey() } : undefined,
      );
      if (result.outcome !== "issued") throw new ContainerNodeError(result.outcome);
      const { id, installToken, expiresAt } = result;
      return { id, installToken, expiresAt, origin };
    },
    async getCompose(guardianId, id) {
      const result = repo.compose(guardianId, id, await loadComposeKey());
      if (result.outcome !== "available") throw new ContainerNodeError(result.outcome);
      return result.grant;
    },
    async renameInstallation(guardianId, id, name) {
      if (!repo.renameInstallation(guardianId, id, name))
        throw new ContainerNodeError("node_not_found");
    },
    async removeInstallation(guardianId, id) {
      const outcome = repo.removeInstallation(guardianId, id);
      if (outcome !== "removed") throw new ContainerNodeError(outcome);
    },
    async switchStatus(guardianId, id, address) {
      const node = repo.list(guardianId).find((row) => row.id === id);
      if (!node) throw new ContainerNodeError("node_not_found");
      if (!node.deviceId) throw new ContainerNodeError("needs_pairing");
      return shellySwitchStatus(await run(node.deviceId, switchAction, { address }));
    },
  };

  return {
    service,
    attach,
    findByBearer,
    deviceOwner,
    run,
    redeem(id: string, token: string, verifier: string) {
      const result = repo.redeem(id, token, verifier);
      if (result.outcome !== "redeemed") return result;
      return {
        outcome: "redeemed" as const,
        response: {
          installation_id: id,
          token_type: "Bearer",
          device_id: result.deviceId,
          access_token: result.token,
          caller_id: callerId(result.guardianId),
        },
      };
    },
    deviceStatuses(): DevicesStatus["devices"] {
      return repo.devices().flatMap(({ installationId, deviceId, name }) =>
        deviceId
          ? [
              {
                id: deviceId,
                installationId,
                name,
                platform: "linux",
                status: online(deviceId) ? "connected" : "not_connected",
              },
            ]
          : [],
      );
    },
    rename(deviceId: string, name: string): DeviceManageResult {
      const validated = containerNodeNameSchema.safeParse(name);
      if (!validated.success) return { ok: false, code: "invalid_device_name" };
      return repo.rename(deviceId, validated.data)
        ? { ok: true }
        : { ok: false, code: "device_not_found" };
    },
    remove(deviceId: string): DeviceManageResult {
      if (!repo.revoke(deviceId)) return { ok: false, code: "device_not_found" };
      closeDevice(deviceId, 4001);
      return { ok: true };
    },
  };
}

export type LocalContainerNodes = NonNullable<ReturnType<typeof createLocalContainerNodes>>;

export function withLocalContainerNodes(
  devices: ReturnType<typeof createNodeDevicesService>,
  local: LocalContainerNodes | undefined,
): typeof devices {
  if (!local) return devices;
  return {
    ...devices,
    async getStatus() {
      const status = await devices.getStatus();
      return { ...status, devices: [...status.devices, ...local.deviceStatuses()] };
    },
    async listFiles(id, path) {
      return local.deviceOwner(id)
        ? { ok: false, code: "unavailable" }
        : devices.listFiles(id, path);
    },
    async runAction(id, action, args) {
      return local.deviceOwner(id)
        ? local.run(id, action, args)
        : devices.runAction(id, action, args);
    },
    async renameDevice(id, name) {
      return local.deviceOwner(id) ? local.rename(id, name) : devices.renameDevice(id, name);
    },
    async removeDevice(id) {
      return local.deviceOwner(id) ? local.remove(id) : devices.removeDevice(id);
    },
  };
}
