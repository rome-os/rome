import { hostname } from "node:os";
import { createExecutor, type HostAudit } from "./executor.js";
import { createComputerUseHost, type ComputerUseHost } from "./computer-use.js";
import {
  runHostConnection,
  type HostConnectionOptions,
  type HostCredential,
  type HostEvent,
} from "./host-connection.js";

export type { HostCredential, HostEvent };

export interface HostOptions extends HostConnectionOptions {
  /** Every remote request is recorded here before it runs. An unavailable log refuses them. */
  audit: HostAudit;
  /** A shared native executor, or false to omit computer actions from this host. */
  computerUse?: ComputerUseHost | false;
  /** Accept ordinary window actions only from this instance's authenticated Gateway peer. */
  windowPeer?: string;
}

/** Runs until aborted or authorization ends. The caller owns interaction and credential storage. */
export function connectHost(options: HostOptions): Promise<void> {
  if (options.windowPeer !== undefined && !options.windowPeer)
    throw new Error("A window-only connection requires one instance.");
  const computerUse =
    options.computerUse === false
      ? undefined
      : (options.computerUse ??
        (process.platform === "darwin" ? createComputerUseHost() : undefined));
  return runHostConnection(options, (session, send, sendFrame, secrets) =>
    createExecutor(
      session.name,
      options.audit,
      send,
      secrets,
      sendFrame,
      computerUse,
      options.windowPeer === undefined
        ? undefined
        : { kind: "window_only", peer: options.windowPeer },
    ),
  );
}

export const defaultDeviceName = () =>
  hostname()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80) || "Computer";
