import { authorizeServer } from "@rome-os/node-core/auth";
import { nodeConfigFromEnvironment } from "@rome-os/node-core/client";
import { createLogger } from "../logger.js";
import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

const log = createLogger("rome-node-provisioning");

/** Never rejects. Call at boot and after enrollment without awaiting on the login path. */
export function createNodeCallerProvisioner(): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    if (pending) return pending;
    const token = getInstanceToken();
    const origin = getRomeCloudOrigin();
    if (!token || !origin) return Promise.resolve();
    // Deferring setup also catches synchronous configuration failures without blocking startup.
    pending = Promise.resolve()
      .then(() => authorizeServer(origin, token, nodeConfigFromEnvironment(process.env)))
      .then(() => {
        log.info("Node caller authorization ready");
      })
      .catch(() => {
        log.warn("Node caller authorization failed. Check rome-node auth --server.");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
