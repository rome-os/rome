import type { ActionResponse } from "@rome-os/node-core";
import { z } from "zod";

const tag = z
  .string()
  .max(96)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9_.:+-]*$/);
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const maybeTag = tag.optional().catch(undefined);
const maybeNumber = nonnegativeInteger.optional().catch(undefined);
const flag = z.boolean().optional().catch(undefined);
const actionList = z
  .array(tag)
  .max(128)
  .transform((values) => [...new Set(values)]);
const actions = actionList.optional().catch(undefined);
const version = z.union([tag, nonnegativeInteger]).optional().catch(undefined);

const systemInfo = z.object({
  platform: maybeTag,
  version,
  actions,
  frameVersion: maybeNumber,
  transferVersion: maybeNumber,
  computerUse: flag,
  audit: z
    .object({ state: z.enum(["ok", "unavailable"]) })
    .optional()
    .catch(undefined),
  capabilities: z.array(z.unknown()).max(128).optional().catch(undefined),
});
const computerDescriptor = z.object({
  prefix: z.literal("computer"),
  version,
  configured: flag,
  actions,
});
const permissions = z.object({
  accessibility: flag,
  screenCapture: flag,
  inputMonitoring: flag,
  postEvents: flag,
});
const background = z.object({
  actions,
  coordinateSpace: maybeTag,
  transport: maybeTag,
  realPointer: flag,
  windowSelectionRequired: flag,
  requiresBackgroundApplication: flag,
  foregroundApplicationActions: actions,
  partialObservations: flag,
  observationRegion: flag,
  foregroundNavigationFallback: flag,
  screenshots: flag,
  sessionEnd: flag,
  windowLease: flag,
  windowPreemption: flag,
  sessionRecovery: flag,
  durableWindowOccupancy: flag,
  maxTextLength: maybeNumber,
  maxValueLength: maybeNumber,
});
const computerStatus = z.object({
  version,
  protocolVersion: maybeNumber,
  permissions: permissions.optional().catch(undefined),
  capabilities: z
    .object({ background: background.optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export interface ComputerUseDeviceDiscovery {
  deviceId: string;
  availability: "online" | "offline" | "unknown";
  platform?: string;
  version?: string | number;
  actions?: string[];
  frameVersion?: number;
  transferVersion?: number;
  audit?: "ok" | "unavailable";
  discoveryError?: string;
  computer?: {
    enabled?: boolean;
    configured?: boolean;
    version?: string | number;
    helperVersion?: string | number;
    protocolVersion?: number;
    actions?: string[];
    permissions?: z.infer<typeof permissions>;
    background?: z.infer<typeof background>;
    statusError?: string;
  };
}

/** Reads advertisements for a single device after its caller has selected and authorized it. */
export async function discoverComputerUseDevice(
  deviceId: string,
  client: { run(deviceId: string, action: string, args?: unknown): Promise<ActionResponse> },
): Promise<ComputerUseDeviceDiscovery> {
  const read = async (action: string): Promise<ActionResponse> => {
    try {
      return await client.run(deviceId, action, {});
    } catch {
      return {
        type: "response",
        ok: false,
        error: {
          code: "transport_unavailable",
          message: "Device discovery could not reach the transport.",
        },
      };
    }
  };
  const info = await read("system.info");
  if (!info.ok)
    return {
      deviceId,
      availability: info.error.code === "target_unavailable" ? "offline" : "unknown",
      discoveryError: maybeTag.parse(info.error.code) ?? "discovery_failed",
    };
  const parsed = systemInfo.safeParse(info.result);
  if (!parsed.success)
    return { deviceId, availability: "online", discoveryError: "invalid_response" };
  const {
    actions,
    platform,
    version,
    frameVersion,
    transferVersion,
    audit,
    computerUse,
    capabilities,
  } = parsed.data;
  const descriptors = capabilities?.flatMap((entry) => {
    const value = computerDescriptor.safeParse(entry);
    return value.success ? [value.data] : [];
  });
  const descriptor = descriptors?.length === 1 ? descriptors[0] : undefined;
  const advertised = (actions ?? descriptor?.actions)?.filter((action) =>
    action.startsWith("computer."),
  );
  const result: ComputerUseDeviceDiscovery = {
    deviceId,
    availability: "online",
    platform,
    version,
    actions,
    frameVersion,
    transferVersion,
    audit: audit?.state,
  };
  if (!descriptor && advertised === undefined && computerUse === undefined) return result;

  const computer: NonNullable<ComputerUseDeviceDiscovery["computer"]> = {
    enabled: computerUse,
    configured: descriptor?.configured,
    version: descriptor?.version,
    actions: advertised,
  };
  result.computer = computer;
  if (
    computerUse === false ||
    descriptor?.configured === false ||
    audit?.state === "unavailable" ||
    !advertised?.includes("computer.status")
  )
    return result;

  const status = await read("computer.status");
  if (!status.ok) {
    computer.statusError = maybeTag.parse(status.error.code) ?? "status_failed";
    if (status.error.code === "target_unavailable") result.availability = "offline";
    if (status.error.code === "computer_use_off") computer.enabled = false;
    return result;
  }
  const helper = computerStatus.safeParse(status.result);
  if (!helper.success) {
    computer.statusError = "invalid_response";
    return result;
  }
  computer.helperVersion = helper.data.version;
  computer.protocolVersion = helper.data.protocolVersion;
  computer.permissions = helper.data.permissions;
  computer.background = helper.data.capabilities?.background;
  return result;
}
