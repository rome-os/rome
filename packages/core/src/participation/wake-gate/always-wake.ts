import type { WakeGate } from "./index.js";

/** Every message wakes the agent, whoever said it and wherever. */
export const alwaysWake: WakeGate = () => "wake";
