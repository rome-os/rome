// Which device connection answers a live read for a turn, and in what state.
// The one place that chooses a device: `core:device_run` and the personal-data
// pointer both ask here, so neither reads the device table. Concept:
// docs/domains/connections.md#device-connection.

import type { ThreadContext } from "@rome-os/app-runtime";
import type { DeviceConnection, DeviceConnectionsRepository } from "./repository.js";
import type { DeviceConnectionState } from "./report.js";

export const DEVICE_DESCRIBE_ACTION = "core:device_describe";
export const DEVICE_RUN_ACTION = "core:device_run";

/** A device whose last report is older than this is not chosen, and shows as stale. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The header the Rome app sends its node device id in, with each message it sends. */
export const ASKING_DEVICE_HEADER = "x-rome-device";

/** The turn's thread-context key for the device the guardian sent from. */
const ASKING_DEVICE = "askingDeviceId";

const DEVICE_ID = /^[A-Za-z0-9-]{1,100}$/;

/**
 * The thread context of a turn the guardian started from `deviceId`, the node
 * device id the app sends with the message. Unchanged for a missing or
 * malformed id.
 */
export function withAskingDevice<T extends object>(context: T, deviceId: string | undefined): T {
  return deviceId && DEVICE_ID.test(deviceId) ? { ...context, [ASKING_DEVICE]: deviceId } : context;
}

/** The device the guardian started the turn from, or undefined (web, routines). */
export function askingDeviceOf(context: ThreadContext | undefined): string | undefined {
  const value = (context as Record<string, unknown> | undefined)?.[ASKING_DEVICE];
  return typeof value === "string" ? value : undefined;
}

/** What a live read needs to know of its turn. */
export interface LiveTurn {
  /** The device the guardian asks from; it alone is asked, with no fallback. */
  askingDeviceId?: string;
}

/** The connection a live read goes to, read when asked. */
export type LivePointer =
  | {
      id: string;
      /** The connection's capability, the kind `system:connect_service` takes for it. */
      kind: string;
      title: string;
      device: { id: string; name: string | null };
      /** `working`, `off` (Live access is off) or `broken` (permission denied). */
      state: DeviceConnectionState;
      lastSeenAt: string;
      /** Its device has not reported for 7 days. Shown only when it is asked anyway. */
      stale?: true;
    }
  | {
      state: "not_connected";
      connect: string;
      /** The kind `system:connect_service` takes, when another device names it. */
      kind?: string;
      /** The asking device, which has no such connection. */
      device?: { id: string };
    };

export interface LiveRoutes {
  /**
   * The connection that reads a personal-data source live for this turn: on
   * the asking device only, else a working one that reported within 7 days,
   * the install whose origin holds the data first.
   */
  forSource(feeds: string, turn: LiveTurn, prefer?: { originId?: string | null }): LivePointer;
}

/** Finds none: a store read with no device connections. */
export const NO_LIVE_ROUTES: LiveRoutes = { forSource: () => notConnected() };

export function createLiveRoutes(
  connections: Pick<DeviceConnectionsRepository, "list">,
  now: () => number = Date.now,
): LiveRoutes & {
  /** The connection of one capability for this turn, as a connect card checks it. */
  forKind(kind: string, turn: LiveTurn): LivePointer;
  /** The connection for one operation, as `core:device_run` runs it. */
  forOperation(
    operation: string,
    turn: LiveTurn & { deviceId?: string },
  ): { connection: DeviceConnection; pointer: LivePointer } | { pointer: LivePointer };
} {
  return {
    forSource(feeds, turn, prefer) {
      const all = connections.list().filter((c) => c.feeds === feeds);
      const chosen = choose(all, turn, now(), prefer?.originId ?? undefined);
      return chosen ? pointerOf(chosen, now()) : notConnected(all[0]?.capability, turn);
    },
    forKind(kind, turn) {
      const all = connections.list().filter((c) => c.capability === kind);
      const chosen = choose(all, turn, now());
      return chosen ? pointerOf(chosen, now()) : notConnected(all[0] ? kind : undefined, turn);
    },
    forOperation(operation, turn) {
      const all = connections.list();
      const offering = all.filter((c) => c.operations.some((o) => o.name === operation));
      const chosen = choose(
        offering,
        { ...turn, askingDeviceId: turn.deviceId ?? turn.askingDeviceId },
        now(),
      );
      if (chosen) return { connection: chosen, pointer: pointerOf(chosen, now()) };
      // The kind, from any device whose capability has the operation's prefix.
      const prefix = operation.split(".")[0];
      const kind = (offering[0] ?? all.find((c) => c.prefix === prefix))?.capability;
      return {
        pointer: notConnected(kind, { askingDeviceId: turn.deviceId ?? turn.askingDeviceId }),
      };
    },
  };
}

const RANK = { working: 0, off: 1, broken: 2 } as const;

/**
 * The asking device's connection, whatever its state, and never another
 * device's. Without one: among those that reported within 7 days, a working
 * one first, the install that holds `originId`'s data first, then the one
 * heard from last.
 */
function choose(
  candidates: DeviceConnection[],
  turn: LiveTurn,
  now: number,
  originId?: string,
): DeviceConnection | undefined {
  if (turn.askingDeviceId) return candidates.find((c) => c.device.id === turn.askingDeviceId);
  return candidates
    .filter((c) => !isStale(c, now))
    .sort(
      (a, b) =>
        RANK[a.state] - RANK[b.state] ||
        Number(b.originId === originId && originId !== undefined) -
          Number(a.originId === originId && originId !== undefined) ||
        b.lastSeenAt.localeCompare(a.lastSeenAt),
    )[0];
}

export function isStale(connection: Pick<DeviceConnection, "lastSeenAt">, now: number): boolean {
  return now - Date.parse(connection.lastSeenAt) > STALE_AFTER_MS;
}

function pointerOf(connection: DeviceConnection, now: number): LivePointer {
  return {
    id: connection.id,
    kind: connection.capability,
    title: connection.title,
    device: { id: connection.device.id, name: connection.device.name },
    state: connection.state,
    lastSeenAt: connection.lastSeenAt,
    ...(isStale(connection, now) ? { stale: true as const } : {}),
  };
}

function notConnected(kind?: string, turn?: LiveTurn): LivePointer {
  return {
    state: "not_connected",
    connect: turn?.askingDeviceId
      ? "The device the guardian is asking from has no such connection. Ask them to connect it in the Rome app on that device."
      : "No device connection reads this live. Ask the guardian to connect it in the Rome app on their device.",
    ...(kind ? { kind } : {}),
    ...(turn?.askingDeviceId ? { device: { id: turn.askingDeviceId } } : {}),
  };
}
