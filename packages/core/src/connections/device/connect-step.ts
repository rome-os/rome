// What the Agent tells the guardian when a device connection cannot answer:
// the step to turn it on. The personal-data pointer and `core:device_run`
// give the same words. Concept: docs/domains/connections.md#device-connection.

import type { DeviceConnectionState } from "./report.js";

export type ConnectStepTarget =
  | {
      /** The connection's capability, the kind `connect_service` takes for it. */
      kind: string;
      title: string;
      device: { name: string | null };
      state: DeviceConnectionState;
    }
  | { state: "not_connected"; kind?: string; device?: { id: string } };

/**
 * The step for a connection that is not working, or undefined for one that
 * is. `before` is what the Agent does first in the same reply, such as
 * answering from stored data.
 */
export function connectStep(target: ConnectStepTarget, before?: string): string | undefined {
  const then = (verb: string) => (before ? `${before}, then ${verb}` : capitalize(verb));
  if (target.state === "not_connected") {
    const there = target.device ? "the device they are asking from" : "their device";
    return target.kind
      ? `${then("offer")} to connect it: show the card with connect_service and kind ` +
          `"${target.kind}" when connect_service lists it, otherwise ask the guardian to connect ` +
          `it in the Rome app on ${there}.`
      : `${then("ask")} the guardian to connect it in the Rome app on ${there}.`;
  }
  const on = target.device.name ? `${target.title} on ${target.device.name}` : target.title;
  if (target.state === "off") {
    return (
      `Live access to ${on} is off. ${then("offer")} to turn it on: show the card with ` +
      `connect_service and kind "${target.kind}" when connect_service lists it, otherwise ` +
      "ask the guardian to turn on Live access in the Rome app on their device."
    );
  }
  if (target.state === "broken") {
    return (
      `The device's permission for ${on} is denied. ${then("ask")} the guardian to ` +
      "allow it in the device's settings."
    );
  }
  return undefined;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
