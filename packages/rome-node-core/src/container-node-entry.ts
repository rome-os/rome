import { setTimeout as delay } from "node:timers/promises";
import { runContainerNode } from "./container-node.js";

const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());

try {
  const result = await runContainerNode({
    origin: process.env.ROME_NODE_CLOUD_URL ?? "",
    deviceToken: process.env.ROME_NODE_TOKEN ?? "",
    callerId: process.env.ROME_NODE_CALLER_ID,
    signal: shutdown.signal,
    onStatus: (status) => console.info(`Container node connection: ${status}`),
  });
  if (result !== "stopped") {
    // Stay idle after revocation or supersession so Docker does not keep restarting the node.
    while (!shutdown.signal.aborted)
      await delay(2_147_483_647, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} catch {
  console.error("Container node could not start. Check the generated Compose configuration.");
  process.exitCode = 1;
}
