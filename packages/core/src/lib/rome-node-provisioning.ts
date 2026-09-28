import { authorizeServer } from "@rome-os/node-core/auth";
import {
  nodeConfigFromEnvironment,
  readOptionalCallerCredential,
  startDaemon,
} from "@rome-os/node-core/client";
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
    // Deferring setup also catches synchronous configuration failures without blocking startup.
    pending = Promise.resolve()
      .then(async () => {
        const config = nodeConfigFromEnvironment(process.env);
        if (token && origin) {
          await authorizeServer(origin, token, config);
          log.info("Node caller authorization ready");
        } else if (!(await readOptionalCallerCredential(config))) {
          return;
        }
        try {
          await startDaemon(config);
          log.info("Node caller daemon started");
        } catch (error) {
          log.warn("Node caller daemon failed to start", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .catch(() => {
        log.warn("Node caller setup failed. Check rome-node auth status.");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
