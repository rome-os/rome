import { platform } from "node:os";
import { actionError, isRecord, type ActionResponse } from "./actions.js";
import { decodeMeta, encodeMeta, FRAME_TYPE, type Frame } from "./frame.js";
import type { InboundEnvelope, OutboundEnvelope } from "./protocol.js";

// This file is the whole of what a computer with Computer use turned off does with a request.
// It must never import the executor, the transfer host, child_process, or the file system: with
// no such code reachable from here, the refusal cannot be bypassed by a malformed request.

/** The error every action but system.info gets while Computer use is off. */
export const COMPUTER_USE_OFF = actionError(
  "computer_use_off",
  "Computer use is turned off on this Mac, so it did not run the request.",
);

const empty = new Uint8Array();

/**
 * Answers requests for a computer that stays connected but lets nothing run. `system.info` says
 * so, and every other request gets `computer_use_off` as a normal error reply, so a caller does
 * not wait for a timeout. Nothing is recorded in an audit log: no request reaches anything.
 */
export function createLimitedResponder(
  name: string,
  send: (message: OutboundEnvelope) => boolean,
  sendFrame: (frame: Frame) => boolean = () => false,
) {
  const info = (): ActionResponse => ({
    type: "response",
    ok: true,
    result: {
      name,
      platform: platform() === "darwin" ? "macos" : platform() === "win32" ? "windows" : platform(),
      // Nothing can run. transferVersion is left out on purpose, so rome-node cp stops early.
      actions: [],
      computerUse: false,
      frameVersion: 1,
    },
  });
  const answer = (action: string): ActionResponse =>
    action === "system.info" ? info() : COMPUTER_USE_OFF;
  return {
    receive(message: InboundEnvelope): void {
      const request = message.payload;
      if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
        return;
      send({ id: message.id, to: message.from, payload: answer(request.action) });
    },
    /** Replies to a request frame with a response frame. Other frames are ignored. */
    receiveFrame(frame: Frame): void {
      if (frame.type !== FRAME_TYPE.request) return;
      const request = decodeMeta(frame.meta);
      if (!isRecord(request) || request.type !== "request" || typeof request.action !== "string")
        return;
      sendFrame({
        type: FRAME_TYPE.response,
        id: frame.id,
        peer: frame.peer,
        meta: encodeMeta(answer(request.action)),
        body: empty,
      });
    },
    idle: () => Promise.resolve(),
    disconnect(): void {},
  };
}
