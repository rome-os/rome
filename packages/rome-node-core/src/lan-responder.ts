import { isIPv4 } from "node:net";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "./frame.js";
import type { HostResponder } from "./host-connection.js";
import type { OutboundEnvelope } from "./protocol.js";

const switchStatus = "lan.shelly.switch.status";
const maxReplyBytes = 8192;

async function readSwitch(address: string, signal: AbortSignal): Promise<ActionResponse> {
  try {
    const response = await fetch(`http://${address}/rpc/Switch.GetStatus?id=0`, {
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        return actionError("lan_auth_required", "The switch requires local authentication.");
      return actionError("lan_unreachable", "The switch did not return its status.");
    }
    const reader = response.body.getReader();
    const bytes = new Uint8Array(maxReplyBytes);
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.length) {
        await reader.cancel();
        return actionError("lan_unreachable", "The switch status was too large.");
      }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
    if (isRecord(body) && body.id === 0 && typeof body.output === "boolean")
      return { type: "response", ok: true, result: { on: body.output } };
  } catch {
    // Keep peer-controlled response content and transport errors off Gateway.
  }
  return actionError("lan_unreachable", "Could not read the switch status at this address.");
}

function lanAddress(args: unknown): string | null {
  if (!isRecord(args) || Object.keys(args).length !== 1 || typeof args.address !== "string")
    return null;
  return isIPv4(args.address) && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(args.address)
    ? args.address
    : null;
}

export function createLanResponder(
  name: string,
  callerId: string,
  send: (message: OutboundEnvelope) => boolean,
  sendFrame: (frame: Frame) => boolean,
): HostResponder {
  let generation = 0;
  let active: { controller: AbortController; request: Promise<ActionResponse> } | undefined;
  async function answer(peer: string, request: unknown, hasBody = false) {
    if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
      return;
    // Gateway stamps this peer from the authenticated sender on every message.
    if (peer.toLowerCase() !== callerId)
      return actionError(
        "permission_denied",
        "This LAN Node is paired with another Rome instance.",
      );
    if (hasBody) return actionError("invalid_args", "LAN Node actions take JSON arguments.");
    if (request.action === "system.info") {
      return {
        type: "response",
        ok: true,
        result: {
          name,
          platform: "linux",
          actions: [switchStatus],
          computerUse: false,
          frameVersion: 1,
        },
      } satisfies ActionResponse;
    }
    if (request.action !== switchStatus)
      return actionError("unsupported_action", "This action is unavailable on a LAN Node.");
    const address = lanAddress(request.args);
    if (!address) return actionError("invalid_lan_address", "Enter a private IPv4 address.");
    if (active) return actionError("lan_busy", "A switch status check is already running.");
    const controller = new AbortController();
    active = { controller, request: readSwitch(address, controller.signal) };
    try {
      return await active.request;
    } finally {
      active = undefined;
    }
  }
  return {
    async receive({ id, from, payload }) {
      const started = generation;
      const result = await answer(from, payload);
      if (result && started === generation) send({ id, to: from, payload: result });
    },
    async receiveFrame(frame) {
      if (frame.type !== FRAME_TYPE.request) return;
      const started = generation;
      const result = await answer(frame.peer, decodeMeta(frame.meta), frame.body.byteLength > 0);
      if (result && started === generation) {
        sendFrame({
          ...frame,
          type: FRAME_TYPE.response,
          meta: encodeMeta(result),
          body: new Uint8Array(),
        });
      }
    },
    disconnect() {
      generation++;
      active?.controller.abort();
    },
    async idle() {
      await active?.request;
    },
  };
}
