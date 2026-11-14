// Where an Agent can read what the store does not hold: the device connection
// a source names. The store points; it never says how to run the device.
// Contract: docs/personal-data.md#live.

import type {
  DeviceConnection,
  DeviceConnectionsRepository,
} from "../connections/device/repository.js";

/** How personal data finds a device connection. */
export type ConnectionLookup = Pick<DeviceConnectionsRepository, "byId" | "feeding">;

/** Finds none: a store read with no device connections. */
export const NO_CONNECTIONS: ConnectionLookup = {
  byId: () => undefined,
  feeding: () => undefined,
};

export type ConnectionPointer =
  | {
      id: string;
      /** The connection's capability, the kind `connect_account` takes for it. */
      kind: string;
      title: string;
      device: { id: string; name: string | null };
      /** `working`, `off` (Live access is off) or `broken` (permission denied). */
      state: DeviceConnection["state"];
      lastSeenAt: string;
    }
  | { state: "not_connected"; connect: string };

const NOT_CONNECTED: ConnectionPointer = {
  state: "not_connected",
  connect:
    "No device connection reads this source live. Ask the guardian to connect it with connect_account.",
};

/**
 * The pointer for a source, read when asked: the connection its sync named,
 * or, before a first sync or with sync off, the one whose device says it
 * syncs to the source.
 */
export function connectionPointer(
  source: string,
  connectionId: string | null | undefined,
  connections: ConnectionLookup,
): ConnectionPointer {
  const connection: DeviceConnection | undefined =
    (connectionId ? connections.byId(connectionId) : undefined) ?? connections.feeding(source);
  if (!connection) return NOT_CONNECTED;
  return {
    id: connection.id,
    kind: connection.capability,
    title: connection.title,
    device: { id: connection.device.id, name: connection.device.name },
    state: connection.state,
    lastSeenAt: connection.lastSeenAt,
  };
}

/**
 * What the Agent does in the reply that found the gap: read it live when the
 * connection works, otherwise what to turn on. The query carries it so the step does not hang on prompt
 * prose alone; the catalog lists the pointer without it.
 */
export function withNextStep(pointer: ConnectionPointer): ConnectionPointer & { next?: string } {
  const fresh = "In this same reply, answer from the stored data and say how fresh it is";
  if (pointer.state === "not_connected") {
    return {
      ...pointer,
      next: `${fresh}, then ask the guardian to connect it in the Rome app on their device.`,
    };
  }
  const on = pointer.device.name ? `${pointer.title} on ${pointer.device.name}` : pointer.title;
  if (pointer.state === "off") {
    return {
      ...pointer,
      next:
        `Live access to ${on} is off. ${fresh}, then offer to turn it on: show the card with ` +
        `connect_account and kind "${pointer.kind}" when connect_account lists it, otherwise ` +
        "ask the guardian to turn on Live access in the Rome app on their device.",
    };
  }
  if (pointer.state === "broken") {
    return {
      ...pointer,
      next:
        `The device's permission for ${on} is denied. ${fresh}, then ask the guardian to ` +
        "allow it in the device's settings.",
    };
  }
  // Working: the device reads the gap now, and is often in front just after
  // it connected, while a backfill is still landing. A check scheduled for
  // later would answer long after the data arrived.
  return {
    ...pointer,
    next:
      `Read the rest from ${on} live now: rome-node device run ${pointer.device.id} <action>, ` +
      `arguments from rome-node device describe ${pointer.device.id}. Do not schedule a later ` +
      "check for this. If the device does not answer, answer from the stored data and say how " +
      "fresh it is.",
  };
}
