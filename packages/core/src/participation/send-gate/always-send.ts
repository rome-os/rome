import type { SendGate } from "./index.js";

/** Every message goes out unchecked, wherever it goes and whoever reads it. */
export const alwaysSend: SendGate = () => "send";
