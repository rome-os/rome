// The wake gate: does a message wake the agent. Rules:
// docs/domains/participation.md#wake-gate.
export type {
  WakeDecision,
  WakeGate,
  WakeGateFor,
  WakeMessage,
  WakeSender,
} from "@rome-os/app-runtime";

export { chatSettingsWake, type ChatWakeSettings } from "./chat-settings-wake.js";
export { wakeGateLoader, type WakeGateLoaderDeps } from "./load.js";
export { alwaysWake } from "./always-wake.js";
