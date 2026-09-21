import { execFile } from "node:child_process";
import { createLogger } from "../logger.js";
import { getInstanceToken } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

const log = createLogger("rome-node-provisioning");

/** Never rejects. Call at boot and after enrollment without awaiting on the login path. */
export function createNodeCallerProvisioner(): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    // Boot and enrollment can overlap. Share the child until it exits.
    if (pending) return pending;
    const token = getInstanceToken();
    const origin = getRomeCloudOrigin();
    if (!token || !origin) return Promise.resolve();
    pending = new Promise<void>((resolve) => {
      const child = execFile(
        "rome-node",
        ["auth", "--server", "--cloud", origin],
        {
          env: { ...process.env, ROME_INSTANCE_TOKEN: token },
          timeout: 120_000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          windowsHide: true,
        },
        (error) => {
          // Do not forward child output or exception text into Core logs.
          if (error) log.warn("CLI caller authorization failed. Check rome-node auth --server.");
          else log.info("CLI caller authorization ready");
          resolve();
        },
      );
      child.stdin?.end();
    })
      .catch(() => {
        log.warn("Could not run CLI caller authorization");
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
