import { z } from "@rome-os/app-runtime";
import type { Action, ActionConfig, AppActionRuntimeDeps } from "@rome-os/app-runtime";
import { type ConnectionControlDeps, connectionControlAction } from "../connection-control.js";

export const connectServiceInputSchema = z.object({
  kind: z
    .string()
    .describe(
      'The kind of service to connect, such as "github", "slack" or "shopify", or a device kind such as "apple_health".',
    ),
});

export function createAction(
  config: ActionConfig,
  deps: AppActionRuntimeDeps<ConnectionControlDeps>,
): Action {
  return connectionControlAction("connect", connectServiceInputSchema, config, deps);
}
