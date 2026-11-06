import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { liveWatchEnv } from "../../watch/env.js";
import { adapterOf } from "../../watch/registry.js";

const inputSchema = z.object({
  source: z.string().trim().min(1),
  target: z.string().trim().optional(),
  kinds: z.array(z.string()).min(1),
  dryRun: z.boolean().default(false),
});

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ source, target, kinds, dryRun }) => {
      const adapter = adapterOf(source);
      if (!adapter) return { status: "error", error: `Rome cannot watch "${source}".` };
      const result = await adapter.ensure(liveWatchEnv(deps), { target, kinds, dryRun });
      return result.ok
        ? { status: "ok", data: { subscription: result.subscription } }
        : { status: "error", error: result.error };
    },
  });
}
