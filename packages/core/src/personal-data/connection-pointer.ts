// Where an Agent can read what the store does not hold: the device connection
// the connection layer chooses. The store points; it never says how to run the device.
// Contract: docs/personal-data.md#live.

import { connectStep } from "../connections/device/connect-step.js";
import {
  DEVICE_DESCRIBE_ACTION,
  DEVICE_RUN_ACTION,
  type LivePointer,
  type LiveRoutes,
  type LiveTurn,
  NO_LIVE_ROUTES,
} from "../connections/device/live-route.js";

/** How personal data finds a device connection: it asks the connection layer, never its table. */
export type ConnectionLookup = LiveRoutes;

/** A gap up to this long is answered from the store; a wider one is read live. */
export const LIVE_READ_GAP_MS = 60 * 60 * 1000;

/** Finds none: a store read with no device connections. */
export const NO_CONNECTIONS: ConnectionLookup = NO_LIVE_ROUTES;

export type ConnectionPointer = LivePointer;

/**
 * The pointer for a source, read when asked: the connection the connection
 * layer chooses for this turn, the install that holds `originId`'s data first.
 */
export function connectionPointer(
  source: string,
  turn: LiveTurn,
  connections: ConnectionLookup,
  originId?: string | null,
): ConnectionPointer {
  return connections.forSource(source, turn, { originId });
}

/**
 * What the Agent does in the reply that found the gap: read it live when the
 * connection works, otherwise what to turn on. The query carries it so the step does not hang on prompt
 * prose alone; the catalog lists the pointer without it.
 */
export function withNextStep(
  pointer: ConnectionPointer,
  gapMs = Number.POSITIVE_INFINITY,
): ConnectionPointer & { next?: string } {
  const fresh = "In this same reply, answer from the stored data and say how fresh it is";
  const step = connectStep(pointer, fresh);
  if (step) return { ...pointer, next: step };
  if (pointer.state === "not_connected") return pointer;
  const on = pointer.device.name ? `${pointer.title} on ${pointer.device.name}` : pointer.title;
  // Working, and the store lags by minutes: a live read would cost more than
  // it adds.
  if (gapMs <= LIVE_READ_GAP_MS) {
    return {
      ...pointer,
      next:
        `${fresh}, which is under an hour behind. Read live only when the guardian asks about the ` +
        "last minutes, and schedule no later check.",
    };
  }
  // Working with a wider gap: the device reads it now, and is often in front
  // just after it connected, while a backfill is still landing. A check
  // scheduled for later would answer long after the data arrived.
  return {
    ...pointer,
    next:
      `Read the rest from ${on} live now with ${DEVICE_RUN_ACTION} and device ` +
      `"${pointer.device.id}", the operation and arguments from ${DEVICE_DESCRIBE_ACTION}. Do not ` +
      "schedule a later check for this. If the " +
      "device does not answer, answer from the stored data and say how fresh it is.",
  };
}
