// Where an Agent can read what the store does not hold: the device connection
// a source names. The store points; it never says how to run the device.
// Contract: docs/personal-data.md#live.

import type { DeviceConnection } from "../connections/device/repository.js";

export type ConnectionPointer =
  | {
      id: string;
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

/** The pointer for a source row's `connectionId`, read when asked. */
export function connectionPointer(
  connectionId: string | null | undefined,
  connectionOf: (id: string) => DeviceConnection | undefined,
): ConnectionPointer {
  const connection = connectionId ? connectionOf(connectionId) : undefined;
  if (!connection) return NOT_CONNECTED;
  return {
    id: connection.id,
    title: connection.title,
    device: { id: connection.device.id, name: connection.device.name },
    state: connection.state,
    lastSeenAt: connection.lastSeenAt,
  };
}
