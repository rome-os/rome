import { hostname } from "node:os";
import { createExecutor, type HostAudit } from "./executor.js";
import type { ComputerUseHost } from "./computer-use.js";
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
  /** Native computer-use host for one active connection at a time (`disconnect()` stops all of its sessions), or false/omitted to leave computer actions disabled. */
  computerUse?: ComputerUseHost | false;
}

/** Runs until aborted or authorization ends. The caller owns interaction and credential storage. */
export function connectHost(options: HostOptions): Promise<void> {
  const computerUse = options.computerUse || undefined;
  return runHostConnection(options, (session, send, sendFrame, secrets) =>
    createExecutor(session.name, options.audit, send, secrets, sendFrame, computerUse),
  );
}

export const defaultDeviceName = () =>
  hostname()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80) || "Computer";
