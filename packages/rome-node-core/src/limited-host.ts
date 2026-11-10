import { runHostConnection, type HostConnectionOptions } from "./host-connection.js";
import { createLimitedResponder } from "./limited.js";

export type LimitedHostOptions = HostConnectionOptions;

/**
 * Connects this computer to the Gateway as a device that runs nothing: it answers `system.info`,
 * refuses every other request with `computer_use_off`, and passes notifications on. Same sign-in
 * and connection as `connectHost`, but no executor is built, so no program or file is reachable.
 */
export function connectLimitedHost(options: LimitedHostOptions): Promise<void> {
  return runHostConnection(options, (session, send, sendFrame) =>
    createLimitedResponder(session.name, send, sendFrame),
  );
}
