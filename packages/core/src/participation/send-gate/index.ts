// The send gate: may a message an agent wrote go out. Rules:
// docs/domains/participation.md#send-gate.
export type { SendDecision, SendGate, SendRequest } from "@rome-os/app-runtime";

export { guardedSend } from "./guarded-send.js";
export { alwaysSend } from "./always-send.js";
export { sendGateByAuthor } from "./by-author.js";
