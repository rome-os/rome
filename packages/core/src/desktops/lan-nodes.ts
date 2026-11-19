import {
  type LanNode,
  type LanNodeGrant,
  type DevicesStatus,
  lanNodeGrantSchema,
  lanNodeNameSchema,
  lanSwitchStatusSchema,
} from "@rome/api-types/devices";
import { z } from "zod";
import { cloudBearer, proveIdentity } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";
import { withTracingSuppressed } from "../telemetry.js";
import type { createNodeDevicesService, DeviceRunResult } from "./node-devices.js";

const root = "/api/instance/lan-nodes";
const cloudNodeSchema = z
  .object({ id: z.uuid(), name: lanNodeNameSchema })
  .and(
    z.discriminatedUnion("state", [
      z.object({ state: z.literal("pending"), expiresAt: z.iso.datetime() }),
      z.object({ state: z.literal("paired"), deviceId: z.uuid() }),
      z.object({ state: z.literal("needs_pairing") }),
    ]),
  );
const cloudListSchema = z.object({ instanceId: z.string(), nodes: z.array(cloudNodeSchema) });
const grantSchema = lanNodeGrantSchema.omit({ origin: true }).extend({ instanceId: z.string() });

export class LanNodeError extends Error {
  constructor(
    readonly code:
      | "not_configured"
      | "sign_in_required"
      | "cloud_unsupported"
      | "unavailable"
      | "node_not_found"
      | "already_paired"
      | "offline"
      | "needs_pairing"
      | "invalid_lan_address"
      | "lan_busy"
      | "lan_auth_required"
      | "lan_unreachable",
  ) {
    super(code);
  }
}

const realCloud = { origin: getRomeCloudOrigin, bearer: cloudBearer, prove: proveIdentity };

export function lanSwitchStatus(result: DeviceRunResult) {
  if (!result.ok) {
    switch (result.code) {
      case "target_unavailable":
        throw new LanNodeError("offline");
      case "invalid_lan_address":
      case "lan_busy":
      case "lan_auth_required":
      case "lan_unreachable":
        throw new LanNodeError(result.code);
      default:
        throw new LanNodeError("unavailable");
    }
  }
  const status = lanSwitchStatusSchema.safeParse(result.result);
  if (!status.success) throw new LanNodeError("unavailable");
  return status.data;
}

function nodeStatus(
  node: z.infer<typeof cloudNodeSchema>,
  device: DevicesStatus["devices"][number] | undefined,
): LanNode["status"] {
  if (node.state === "pending")
    return Date.parse(node.expiresAt) > Date.now() ? "waiting" : "needs_pairing";
  if (node.state === "needs_pairing" || device?.status === "revoked") return "needs_pairing";
  if (device?.status === "connected") return "online";
  if (device?.status === "not_connected") return "offline";
  return "unknown";
}

export function createLanNodesService(
  devices: Pick<ReturnType<typeof createNodeDevicesService>, "getStatus" | "runAction">,
  cloud = realCloud,
) {
  async function request(
    accountId: string,
    path: string,
    signal: AbortSignal,
    body?: { name: string } | Record<string, never>,
  ) {
    const url = URL.parse(cloud.origin() ?? "");
    if (url?.protocol !== "https:") throw new LanNodeError("not_configured");
    const origin = url.origin;
    const token = await cloud.bearer();
    if (!token) throw new LanNodeError("not_configured");
    const proof = await cloud.prove({ credential: { origin, token } });
    if (proof.status === "unknown" || proof.status === "revoked")
      throw new LanNodeError("sign_in_required");
    if (proof.status !== "ok") throw new LanNodeError("unavailable");
    if (proof.identity.accountId !== accountId) throw new LanNodeError("sign_in_required");

    const response = await withTracingSuppressed(() =>
      fetch(new URL(path, origin), {
        method: body ? "POST" : "GET",
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
      throw new LanNodeError("unavailable");
    });
    const data: unknown = await response.json().catch(() => null);
    if (response.ok) return { data, origin, instanceId: proof.identity.instanceId };
    const error = z.object({ error: z.string() }).safeParse(data).data?.error;
    if (response.status === 404)
      throw new LanNodeError(error === "node_not_found" ? "node_not_found" : "cloud_unsupported");
    if (response.status === 409 && error === "already_paired")
      throw new LanNodeError("already_paired");
    if (response.status === 401 || response.status === 403)
      throw new LanNodeError("sign_in_required");
    throw new LanNodeError("unavailable");
  }

  async function list(accountId: string, signal: AbortSignal) {
    const result = await request(accountId, root, signal);
    const parsed = cloudListSchema.safeParse(result.data).data;
    if (!parsed || parsed.instanceId !== result.instanceId) throw new LanNodeError("unavailable");
    return parsed.nodes;
  }

  return {
    async list(accountId: string, signal: AbortSignal): Promise<{ nodes: LanNode[] }> {
      const nodes = await list(accountId, signal);
      const status = nodes.some((node) => node.state === "paired")
        ? await devices.getStatus()
        : null;
      const byId = new Map(status?.devices.map((device) => [device.id, device]));
      return {
        nodes: nodes.map((node): LanNode => {
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
      input: { name: string } | { id: string },
      signal: AbortSignal,
    ): Promise<LanNodeGrant> {
      const replacing = "id" in input;
      const result = await request(
        accountId,
        replacing ? `${root}/${input.id}/pairing` : root,
        signal,
        replacing ? {} : input,
      );
      const grant = grantSchema.safeParse(result.data).data;
      if (!grant || grant.instanceId !== result.instanceId || (replacing && grant.id !== input.id))
        throw new LanNodeError("unavailable");
      const lifetime = Date.parse(grant.expiresAt) - Date.now();
      if (lifetime <= 0 || lifetime > 15 * 60_000) throw new LanNodeError("unavailable");
      const { id, installToken, expiresAt } = grant;
      return { id, installToken, expiresAt, origin: result.origin };
    },
    async switchStatus(accountId: string, id: string, address: string, signal: AbortSignal) {
      const node = (await list(accountId, signal)).find((item) => item.id === id);
      if (!node) throw new LanNodeError("node_not_found");
      if (node.state !== "paired") throw new LanNodeError("needs_pairing");
      const result = await devices.runAction(node.deviceId, "lan.shelly.switch.status", {
        address,
      });
      return lanSwitchStatus(result);
    },
  };
}

export type LanNodesService = ReturnType<typeof createLanNodesService>;
