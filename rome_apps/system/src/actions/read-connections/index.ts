import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type ConnectionControlDeps, connectionControlAction } from "../connection-control.js";

export const readConnectionsInputSchema = z.object({});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<ConnectionControlDeps>,
): Action {
  return connectionControlAction("read", readConnectionsInputSchema, config, deps);
}
