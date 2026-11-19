import {
  CONTAINER_NODE_GRANT_LIFETIME_MS,
  type ContainerNode,
  type ContainerNodeGrant,
  type DevicesStatus,
  containerNodeGrantSchema,
  containerNodeNameSchema,
  shellySwitchStatusSchema,
} from "@rome/api-types/devices";
import { z } from "zod";
import { cloudBearer, proveIdentity } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";
import { withTracingSuppressed } from "../telemetry.js";
import type { createNodeDevicesService, DeviceRunResult } from "./node-devices.js";

const root = "/api/instance/container-nodes";
// Cloud and Core can disagree slightly about the current time.
const maxCloudGrantLifetime = CONTAINER_NODE_GRANT_LIFETIME_MS + 5 * 60_000;
const cloudNodeSchema = z
  .object({ id: z.uuid(), name: containerNodeNameSchema })
  .and(
    z.discriminatedUnion("state", [
      z.object({ state: z.literal("pending"), expiresAt: z.iso.datetime() }),
      z.object({ state: z.literal("paired"), deviceId: z.uuid() }),
      z.object({ state: z.literal("needs_pairing") }),
    ]),
  );
const cloudListSchema = z.object({ instanceId: z.string(), nodes: z.array(cloudNodeSchema) });
const grantSchema = containerNodeGrantSchema
  .omit({ origin: true })
  .extend({ instanceId: z.string() });

export class ContainerNodeError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "sign_in_required"
      | "cloud_unsupported"
      | "unavailable"
      | "node_not_found"
      | "already_paired"
      | "compose_unavailable"
      | "invalid_origin"
      | "offline"
      | "needs_pairing"
      | "invalid_switch_address"
      | "node_busy"
      | "switch_auth_required"
      | "switch_unreachable",
  ) {
    super(code);
  }
}

const realCloud = { origin: getRomeCloudOrigin, bearer: cloudBearer, prove: proveIdentity };

type PairingInput = ({ name: string } | { id: string }) & { origin?: string };

function readGrant(result: { data: unknown; origin: string; instanceId: string }, id?: string) {
  const grant = grantSchema.safeParse(result.data).data;
  if (!grant || grant.instanceId !== result.instanceId || (id && grant.id !== id))
    throw new ContainerNodeError("unavailable");
  const lifetime = Date.parse(grant.expiresAt) - Date.now();
  if (lifetime <= 0 || lifetime > maxCloudGrantLifetime)
    throw new ContainerNodeError("unavailable");
  return {
    id: grant.id,
    installToken: grant.installToken,
    expiresAt: grant.expiresAt,
    origin: result.origin,
  };
}

export function shellySwitchStatus(result: DeviceRunResult) {
  if (!result.ok) {
    switch (result.code) {
      case "target_unavailable":
        throw new ContainerNodeError("offline");
      case "invalid_switch_address":
      case "node_busy":
      case "switch_auth_required":
      case "switch_unreachable":
        throw new ContainerNodeError(result.code);
      default:
        throw new ContainerNodeError("unavailable");
    }
  }
  const status = shellySwitchStatusSchema.safeParse(result.result);
  if (!status.success) throw new ContainerNodeError("unavailable");
  return status.data;
}

function nodeStatus(
  node: z.infer<typeof cloudNodeSchema>,
  device: DevicesStatus["devices"][number] | undefined,
): ContainerNode["status"] {
  if (node.state === "pending")
    return Date.parse(node.expiresAt) > Date.now() ? "waiting" : "needs_pairing";
  if (node.state === "needs_pairing" || device?.status === "revoked") return "needs_pairing";
  if (device?.status === "connected") return "online";
  if (device?.status === "not_connected") return "offline";
  return "unknown";
}

export function createContainerNodesService(
  devices: Pick<ReturnType<typeof createNodeDevicesService>, "getStatus" | "runAction">,
  cloud = realCloud,
) {
  async function request(
    accountId: string,
    path: string,
    signal: AbortSignal,
    options?:
      | { method: "POST" | "PATCH"; body: { name: string } | Record<string, never> }
      | { method: "DELETE" },
  ) {
    const url = URL.parse(cloud.origin() ?? "");
    if (url?.protocol !== "https:") throw new ContainerNodeError("not_configured");
    const origin = url.origin;
    const token = await cloud.bearer();
    if (!token) throw new ContainerNodeError("not_configured");
    const proof = await cloud.prove({ credential: { origin, token } });
    if (proof.status === "unknown" || proof.status === "revoked")
      throw new ContainerNodeError("sign_in_required");
    if (proof.status !== "ok") throw new ContainerNodeError("unavailable");
    if (proof.identity.accountId !== accountId) throw new ContainerNodeError("sign_in_required");

    const body = options && "body" in options ? options.body : undefined;
    const response = await withTracingSuppressed(() =>
      fetch(new URL(path, origin), {
        method: options?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body && JSON.stringify(body),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      }),
    ).catch(() => {
      throw new ContainerNodeError("unavailable");
    });
    const data: unknown = await response.json().catch(() => null);
    if (response.ok) return { data, origin, instanceId: proof.identity.instanceId };
    const error = z.object({ error: z.string() }).safeParse(data).data?.error;
    if (response.status === 404)
      throw new ContainerNodeError(
        error === "node_not_found" || error === "compose_unavailable" ? error : "cloud_unsupported",
      );
    if (response.status === 409 && error === "already_paired")
      throw new ContainerNodeError("already_paired");
    if (response.status === 401 || response.status === 403)
      throw new ContainerNodeError("sign_in_required");
    throw new ContainerNodeError("unavailable");
  }

  async function list(accountId: string, signal: AbortSignal) {
    const result = await request(accountId, root, signal);
    const parsed = cloudListSchema.safeParse(result.data).data;
    if (!parsed || parsed.instanceId !== result.instanceId)
      throw new ContainerNodeError("unavailable");
    return parsed.nodes;
  }

  return {
    async list(accountId: string, signal: AbortSignal): Promise<{ nodes: ContainerNode[] }> {
      const nodes = await list(accountId, signal);
      const status = nodes.some((node) => node.state === "paired")
        ? await devices.getStatus()
        : null;
      const byId = new Map(status?.devices.map((device) => [device.id, device]));
      return {
        nodes: nodes.map((node): ContainerNode => {
          const device = node.state === "paired" ? byId.get(node.deviceId) : undefined;
          return {
            id: node.id,
            name: device?.name ?? node.name,
            deviceId: node.state === "paired" ? node.deviceId : null,
            status: nodeStatus(node, device),
          };
        }),
      };
    },
    async pair(
      accountId: string,
      input: PairingInput,
      signal: AbortSignal,
    ): Promise<ContainerNodeGrant> {
      const replacing = "id" in input;
      const result = await request(
        accountId,
        replacing ? `${root}/${input.id}/pairing` : root,
        signal,
        { method: "POST", body: replacing ? {} : { name: input.name } },
      );
      return readGrant(result, replacing ? input.id : undefined);
    },
    async getCompose(accountId: string, id: string, signal: AbortSignal) {
      return readGrant(await request(accountId, `${root}/${id}/compose`, signal), id);
    },
    async renameInstallation(accountId: string, id: string, name: string, signal: AbortSignal) {
      await request(accountId, `${root}/${id}`, signal, { method: "PATCH", body: { name } });
    },
    async removeInstallation(accountId: string, id: string, signal: AbortSignal) {
      await request(accountId, `${root}/${id}`, signal, { method: "DELETE" });
    },
    async switchStatus(accountId: string, id: string, address: string, signal: AbortSignal) {
      const node = (await list(accountId, signal)).find((item) => item.id === id);
      if (!node) throw new ContainerNodeError("node_not_found");
      if (node.state !== "paired") throw new ContainerNodeError("needs_pairing");
      const result = await devices.runAction(node.deviceId, "shelly.switch.status", {
        address,
      });
      return shellySwitchStatus(result);
    },
  };
}

export type ContainerNodesService = ReturnType<typeof createContainerNodesService>;
