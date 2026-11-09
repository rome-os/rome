import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { liveWatchEnv } from "../../watch/env.js";
import { ADAPTERS } from "../../watch/registry.js";
import { listWatchSources } from "../../watch/shared/status.js";

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: z.object({}),
    execute: async () => ({
      status: "ok",
      data: await listWatchSources(ADAPTERS, liveWatchEnv(deps)),
    }),
  });
}
