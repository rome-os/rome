import { setTimeout as delay } from "node:timers/promises";
import { runContainerNode } from "./container-node.js";

const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());

try {
  const result = await runContainerNode({
    cloudUrl: process.env.ROME_NODE_CLOUD_URL ?? "",
    installationId: process.env.ROME_NODE_INSTALLATION_ID ?? "",
    installToken: process.env.ROME_NODE_INSTALL_TOKEN,
    stateDir: "/state",
    signal: shutdown.signal,
    onEvent(event) {
      if (event.type === "connection") console.info(`Container node connection: ${event.status}`);
      if (event.type === "pairing_retry")
        console.warn(`Container node pairing retry: ${event.code}`);
    },
  });
  if (result !== "stopped") {
    console.info(`Container node: ${result}`);
    // Keep the container idle until it is replaced, without a Docker restart loop.
    while (!shutdown.signal.aborted)
      await delay(2_147_483_647, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} catch {
  console.error("Container node could not start. Check the deployment and its state volume.");
  process.exitCode = 1;
}
