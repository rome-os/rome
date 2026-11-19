import { containerNodeCredentialSchema, shellySwitchStatusSchema } from "@rome/api-types/devices";
import { cloudOrigin } from "@rome-os/node-core";
import { loginDeviceCode, type DeviceAuthorizationPrompt } from "@rome-os/node-core/host";
import { cloudBearer, proveIdentity } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";
import { withTracingSuppressed } from "../telemetry.js";
import type { DeviceRunResult } from "./node-devices.js";

export const containerNodeErrors = {
  not_configured: 409,
  sign_in_required: 403,
  authorization_failed: 403,
  approval_account_mismatch: 403,
  unavailable: 503,
  node_not_found: 404,
  invalid_origin: 400,
  offline: 503,
  invalid_switch_address: 400,
  node_busy: 429,
  switch_auth_required: 422,
  switch_unreachable: 502,
} as const;

export class ContainerNodeError extends Error {
  constructor(readonly code: keyof typeof containerNodeErrors) {
    super(code);
  }
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

const realCloud = {
  origin: getRomeCloudOrigin,
  bearer: cloudBearer,
  prove: proveIdentity,
  login: loginDeviceCode,
};

export function createContainerNodesService(cloud = realCloud) {
  async function authorize(accountId: string) {
    let origin: string;
    try {
      origin = cloudOrigin(cloud.origin() ?? "");
    } catch {
      throw new ContainerNodeError("not_configured");
    }
    const token = await cloud.bearer();
    if (!token) throw new ContainerNodeError("not_configured");
    const proof = await cloud.prove({ credential: { origin, token } });
    if (proof.status === "unknown" || proof.status === "revoked")
      throw new ContainerNodeError("sign_in_required");
    if (proof.status !== "ok") throw new ContainerNodeError("unavailable");
    if (proof.identity.accountId !== accountId) throw new ContainerNodeError("sign_in_required");
    return origin;
  }

  return {
    authorize,
    async authorizeDevice(
      origin: string,
      name: string,
      signal: AbortSignal,
      onPrompt: (prompt: DeviceAuthorizationPrompt) => void,
    ) {
      const session = await withTracingSuppressed(() =>
        cloud.login(origin, name, signal, onPrompt),
      );
      return containerNodeCredentialSchema.parse({
        origin,
        deviceId: session.deviceId.toLowerCase(),
        deviceToken: session.token,
      });
    },
  };
}
