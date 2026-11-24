import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type ConnectionControlDeps, connectionControlAction } from "../connection-control.js";

export const disconnectServiceInputSchema = z.object({
  connectionId: z.string().describe("The connection's id, from read_connections."),
});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<ConnectionControlDeps>,
): Action {
  return connectionControlAction(
    "disconnect",
    disconnectServiceInputSchema,
    config,
    deps,
    "previewDisconnect",
  );
}
