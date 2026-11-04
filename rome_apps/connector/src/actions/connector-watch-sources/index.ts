import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { watchSourceDeps } from "../../watch/runtime.js";
import { listConnectors } from "../../watch/sources.js";

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: z.object({}),
    execute: async () => ({
      status: "ok",
      data: { connectors: await listConnectors(watchSourceDeps(deps)) },
    }),
  });
}
