// `core:device_describe` and `core:device_run`: how an Agent finds and calls
// what the guardian's devices let it reach live, under the names agents called
// before `system:read_devices` and `system:run_on_device` (agent-tools.ts),
// which share these operations. Both are built from what each
// device reports of its own registry, so core names no capability and a new
// one needs no prompt or core change. Which device answers is the live
// route's choice (live-route.ts). Concept: docs/domains/connections.md#device-connection.

import { runningTurn } from "../../apps/actions/agent-tool.js";
import type { ActionRegistry } from "../../apps/actions/types.js";
import type { ToolTurn } from "../../apps/actions/agent-tool.js";
import type { DeviceRunResult } from "../../desktops/node-devices.js";
import { createLogger } from "../../logger.js";
import { connectStep } from "./connect-step.js";
import {
  askingDeviceOf,
  createLiveRoutes,
  DEVICE_DESCRIBE_ACTION,
  DEVICE_RUN_ACTION,
  isStale,
  type LiveTurn,
  READ_DEVICES_TOOL,
  RUN_ON_DEVICE_TOOL,
} from "./live-route.js";
import type { DeviceConnection, DeviceConnectionsRepository } from "./repository.js";

const log = createLogger("device-actions");

export { DEVICE_DESCRIBE_ACTION, DEVICE_RUN_ACTION };

export interface DeviceActionDeps {
  connections: Pick<DeviceConnectionsRepository, "list">;
  /** Runs one action on a device through core's node client. */
  run: (
    deviceId: string,
    action: string,
    args: Record<string, unknown>,
  ) => Promise<DeviceRunResult>;
  now?: () => number;
}

/** The error code for a connection that cannot answer, by its state. */
const STATE_CODE = { off: "live_off", broken: "permission_denied" } as const;

/**
 * Registers the older names. A change to the device has its own rule in the
 * run.
 */
export function registerDeviceActions(
  actions: Pick<ActionRegistry, "register">,
  deps: DeviceActionDeps,
): void {
  const now = deps.now ?? Date.now;

  actions.register({
    config: {
      name: DEVICE_DESCRIBE_ACTION,
      type: "system",
      // Agents are told of system:read_devices (agent-tools.ts); this name
      // stays for the routines and agent prompts that already call it.
      description:
        "The older name of system:read_devices, which lists the same devices and more: call " +
        "system:read_devices instead. It lists what each device last reported it lets you read " +
        "and do, and asks no device.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      const turn = runningTurn();
      return {
        status: "ok",
        data: describeDevices(deps.connections.list(), now(), askingDeviceOf(turn.channelContext)),
      };
    },
  });

  actions.register({
    config: {
      name: DEVICE_RUN_ACTION,
      type: "system",
      // Agents are told of system:run_on_device (agent-tools.ts); this name
      // stays for the routines and agent prompts that already call it.
      description:
        "The older name of system:run_on_device, with the same rules: call " +
        "system:run_on_device instead. It runs one operation on one of the guardian's devices, " +
        `with the operation and arguments ${DEVICE_DESCRIBE_ACTION} lists.`,
      complexity: "simple",
      speed: "fast",
      reliability: "medium",
      sideEffects: "write",
    },
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description: `The operation's name as ${DEVICE_DESCRIBE_ACTION} lists it.`,
        },
        args: {
          type: "object",
          description: "The operation's arguments, as its input schema says. Default: none.",
        },
        device: {
          type: "string",
          description:
            "A device id from the listing, only for a device the guardian names. Default: the device they are asking from.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
      const turn = runningTurn();
      const {
        operation,
        args = {},
        device,
      } = input as {
        operation?: unknown;
        args?: unknown;
        device?: unknown;
      };
      if (typeof operation !== "string" || !operation) {
        return { status: "error", error: "Invalid input: operation is required." };
      }
      if (args === null || typeof args !== "object" || Array.isArray(args)) {
        return { status: "error", error: "Invalid input: args must be an object." };
      }
      if (device !== undefined && typeof device !== "string") {
        return { status: "error", error: "Invalid input: device must be a device id." };
      }
      const outcome = await runOnDevice({ ...deps, now }, deviceRunTurnOf(turn), {
        operation,
        args: args as Record<string, unknown>,
        deviceId: device,
      });
      return "error" in outcome
        ? { status: "error", error: outcome.error }
        : { status: "ok", data: outcome.data };
    },
  });
}

/** What running one operation on a device needs of its turn. */
export type DeviceRunTurn = LiveTurn & Pick<ToolTurn, "audience">;

/** The running turn as a device run reads it, from the action's store. */
export function deviceRunTurnOf(store: ToolTurn | undefined): DeviceRunTurn {
  return {
    audience: store?.audience,
    askingDeviceId: askingDeviceOf(store?.channelContext),
  };
}

/** The answer of one operation on a device, or the error the agent reads. */
export type DeviceRunOutcome =
  | { data: { device: { id: string; name: string | null }; connection: string; result: unknown } }
  | { error: string };

/**
 * Runs one operation on one of the guardian's devices for `turn`, as
 * `core:device_run` and `system:run_on_device` both do: the live route picks
 * the device, then the rule for a change to the device.
 */
export async function runOnDevice(
  deps: Pick<DeviceActionDeps, "connections" | "run"> & { now?: () => number },
  turn: DeviceRunTurn,
  request: { operation: string; args: Record<string, unknown>; deviceId?: string },
): Promise<DeviceRunOutcome> {
  const routes = createLiveRoutes(deps.connections, deps.now ?? Date.now);
  const route = routes.forOperation(request.operation, {
    askingDeviceId: turn.askingDeviceId,
    deviceId: request.deviceId,
  });
  return runOperation(deps, { audience: turn.audience }, request.operation, request.args, route);
}

async function runOperation(
  deps: Pick<DeviceActionDeps, "run">,
  { audience }: Pick<ToolTurn, "audience">,
  operation: string,
  args: Record<string, unknown>,
  route: ReturnType<ReturnType<typeof createLiveRoutes>["forOperation"]>,
): Promise<DeviceRunOutcome> {
  if (!("connection" in route)) {
    const pointer = route.pointer;
    const where =
      pointer.state === "not_connected" && pointer.device ? " on the asking device" : "";
    return {
      error:
        `not_connected: No device connection${where} offers ${operation}. ` +
        (pointer.state === "not_connected" && pointer.kind
          ? connectStep(pointer)
          : `Call ${READ_DEVICES_TOOL} for what the guardian's devices offer; if none does, ` +
            "ask the guardian to connect it in the Rome app on their device."),
    };
  }
  const chosen = route.connection;
  const access = chosen.operations.find((o) => o.name === operation)?.access;
  if (access !== "read" && access !== "write") {
    return {
      error: `unsupported_operation: ${RUN_ON_DEVICE_TOOL} runs only read and write operations.`,
    };
  }
  if (chosen.state !== "working") {
    return {
      error: `${STATE_CODE[chosen.state]}: ${connectStep(target(chosen))}`,
    };
  }
  const answer = await deps.run(chosen.device.id, operation, args);
  const device = { id: chosen.device.id, name: chosen.device.name };
  if (answer.ok) {
    return { data: { device, connection: chosen.id, result: answer.result } };
  }
  if (answer.code === "target_unavailable") {
    const name = chosen.device.name ?? "The device";
    return {
      error:
        `target_unavailable: ${name} did not answer: it is offline or its Rome app is not ` +
        "running, and Rome keeps no request for later. Say so plainly: the guardian opens the " +
        "Rome app on it and asks again. No connect card brings a device back online. " +
        (access === "write"
          ? "Nothing was changed."
          : "Answer from what you have, such as synced personal data, and say how fresh it is."),
    };
  }
  return { error: `${answer.code}: ${answer.message}` };
}

function target(connection: DeviceConnection) {
  return {
    kind: connection.capability,
    title: connection.title,
    device: { name: connection.device.name },
    state: connection.state,
  };
}

/** The listing: each device with its connections, as the devices last reported them. */
export function describeDevices(
  connections: DeviceConnection[],
  now: number,
  askingDeviceId?: string,
) {
  const devices = new Map<
    string,
    {
      id: string;
      name: string | null;
      platform: string | null;
      lastSeenAt: string;
      asking?: true;
      stale?: true;
      capabilities: unknown[];
    }
  >();
  for (const connection of connections) {
    const entry = devices.get(connection.device.id) ?? {
      ...connection.device,
      lastSeenAt: connection.lastSeenAt,
      capabilities: [],
    };
    if (connection.lastSeenAt > entry.lastSeenAt) entry.lastSeenAt = connection.lastSeenAt;
    const next = connectStep(target(connection));
    entry.capabilities.push({
      kind: connection.capability,
      title: connection.title,
      personal: connection.personal,
      state: connection.state,
      ...(next ? { next } : {}),
      operations: connection.operations,
    });
    devices.set(connection.device.id, entry);
  }
  for (const entry of devices.values()) {
    if (entry.id === askingDeviceId) entry.asking = true;
    if (isStale(entry, now)) entry.stale = true;
  }
  // Named even when the device reports nothing, so the Agent can tell the
  // guardian is on a device with no connection rather than reach for another.
  const asking = askingDeviceId
    ? { askingDevice: { id: askingDeviceId, connected: devices.has(askingDeviceId) } }
    : {};
  return devices.size > 0
    ? { ...asking, devices: [...devices.values()] }
    : {
        ...asking,
        devices: [],
        note: "No device has reported a connection. Ask the guardian to connect one in the Rome app on their device.",
      };
}
