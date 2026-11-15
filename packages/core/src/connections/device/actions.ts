// `core:device_describe` and `core:device_run`: how an Agent finds and calls
// what the guardian's devices let it reach live. Both are built from what each
// device reports of its own registry, so core names no capability and a new
// one needs no prompt or core change. Concept:
// docs/domains/connections.md#device-connection.

import { actionExecutionContext } from "../../apps/actions/context.js";
import { PERSONAL_DATA_PRIVATE_ONLY } from "../../apps/actions/personal-data.js";
import type { ActionRegistry, ActionResult } from "../../apps/actions/types.js";
import type { DeviceRunResult } from "../../desktops/node-devices.js";
import { createLogger } from "../../logger.js";
import { connectStep } from "./connect-step.js";
import type { DeviceConnection, DeviceConnectionsRepository } from "./repository.js";

const log = createLogger("device-actions");

export const DEVICE_DESCRIBE_ACTION = "core:device_describe";
export const DEVICE_RUN_ACTION = "core:device_run";

export interface DeviceActionDeps {
  connections: Pick<DeviceConnectionsRepository, "list">;
  /** Runs one action on a device through core's node client. */
  run: (
    deviceId: string,
    action: string,
    args: Record<string, unknown>,
  ) => Promise<DeviceRunResult>;
  /** The running turn's audience. Default: the action's own run context. */
  audience?: () => string | undefined;
}

/** Working first, then the one heard from last: the phone in the guardian's hand reports on opening. */
const RANK = { working: 0, off: 1, broken: 2 } as const;

/** The error code for a connection that cannot answer, by its state. */
const STATE_CODE = { off: "live_off", broken: "permission_denied" } as const;

export function registerDeviceActions(
  actions: Pick<ActionRegistry, "register">,
  deps: DeviceActionDeps,
): void {
  const audience = deps.audience ?? (() => actionExecutionContext.getStore()?.audience);

  actions.register({
    config: {
      name: DEVICE_DESCRIBE_ACTION,
      type: "system",
      description:
        "List what the guardian's devices, such as their phone, let you read live: each device, " +
        "each capability on it with its state (working, off, broken) and whether it is personal, " +
        "and each operation with what it does, its arguments and examples. Call it before " +
        `${DEVICE_RUN_ACTION}. It reads what the devices last reported and asks no device.`,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "read-only",
    },
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ status: "ok", data: describeDevices(deps.connections.list()) }),
  });

  actions.register({
    config: {
      name: DEVICE_RUN_ACTION,
      type: "system",
      description:
        "Run one operation on one of the guardian's devices now, such as reading its status, with " +
        `the operation and arguments ${DEVICE_DESCRIBE_ACTION} lists. With several devices it uses ` +
        "the one whose connection works and that reported last, unless you name a device. When the " +
        "connection is off or broken, it asks no device and the error says what the guardian can " +
        "turn on. A device that is offline answers target_unavailable at once. A personal " +
        "capability runs only in a private chat with the guardian.",
      complexity: "simple",
      speed: "fast",
      reliability: "medium",
      sideEffects: "read-only",
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
          description: "A device id from the listing, to pick one device among several.",
        },
      },
      additionalProperties: false,
    },
    execute: async (input) => {
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
      return runOperation(deps, audience(), operation, args as Record<string, unknown>, device);
    },
  });
}

async function runOperation(
  deps: DeviceActionDeps,
  audience: string | undefined,
  operation: string,
  args: Record<string, unknown>,
  deviceId: string | undefined,
): Promise<ActionResult> {
  const candidates = deps.connections
    .list()
    .filter(
      (c) =>
        c.operations.some((o) => o.name === operation) &&
        (deviceId === undefined || c.device.id === deviceId),
    )
    .sort((a, b) => RANK[a.state] - RANK[b.state] || b.lastSeenAt.localeCompare(a.lastSeenAt));
  const chosen = candidates[0];
  if (!chosen) {
    const where = deviceId ? ` on device ${deviceId}` : "";
    return {
      status: "error",
      error:
        `not_connected: No device connection${where} offers ${operation}. Call ` +
        `${DEVICE_DESCRIBE_ACTION} for what the guardian's devices offer; if none does, ask ` +
        "the guardian to connect it in the Rome app on their device.",
    };
  }
  // Today's rule, as for the personal-data actions and the rome-node CLI.
  if (chosen.personal && audience !== "private") {
    log.info("personal device operation refused outside a private turn", {
      capability: chosen.capability,
      operation,
    });
    return { status: "error", error: PERSONAL_DATA_PRIVATE_ONLY };
  }
  if (chosen.operations.find((o) => o.name === operation)?.access !== "read") {
    return {
      status: "error",
      error: `unsupported_operation: ${DEVICE_RUN_ACTION} runs only read operations.`,
    };
  }
  if (chosen.state !== "working") {
    return {
      status: "error",
      error: `${STATE_CODE[chosen.state]}: ${connectStep(target(chosen))}`,
    };
  }
  const answer = await deps.run(chosen.device.id, operation, args);
  const device = { id: chosen.device.id, name: chosen.device.name };
  if (answer.ok) {
    return { status: "ok", data: { device, connection: chosen.id, result: answer.result } };
  }
  if (answer.code === "target_unavailable") {
    const name = chosen.device.name ?? "The device";
    return {
      status: "error",
      error:
        `target_unavailable: ${name} did not answer: it is offline or its Rome app is not ` +
        "running, and Rome keeps no request for later. Say so, and answer from what you have.",
    };
  }
  return { status: "error", error: `${answer.code}: ${answer.message}` };
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
export function describeDevices(connections: DeviceConnection[]) {
  const devices = new Map<
    string,
    {
      id: string;
      name: string | null;
      platform: string | null;
      lastSeenAt: string;
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
  return devices.size > 0
    ? { devices: [...devices.values()] }
    : {
        devices: [],
        note: "No device has reported a connection. Ask the guardian to connect one in the Rome app on their device.",
      };
}
