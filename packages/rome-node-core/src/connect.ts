import { hostname } from "node:os";
import type { EnsureComputerUseHelper } from "./computer-use/host.js";
import { createExecutor, type HostAudit } from "./executor.js";
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
  computerUseHelperPath?: string;
  ensureComputerUseHelper?: EnsureComputerUseHelper;
  strictBundledAppPath?: boolean;
}

/** Runs until aborted or authorization ends. The caller owns interaction and credential storage. */
export function connectHost(options: HostOptions): Promise<void> {
  return runHostConnection(options, (session, send, sendFrame, secrets) =>
    createExecutor(
      session.name,
      options.audit,
      send,
      secrets,
      sendFrame,
      options.computerUseHelperPath,
      {
        ensureHelper: options.ensureComputerUseHelper,
        strictBundledAppPath: options.strictBundledAppPath,
      },
    ),
  );
}

export const defaultDeviceName = () =>
  hostname()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 80) || "Computer";
