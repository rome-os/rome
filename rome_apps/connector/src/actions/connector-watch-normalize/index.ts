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
  source: z.string(),
  eventName: z.string(),
  payload: z.record(z.string(), z.unknown()),
  account: z.string().min(1),
  kinds: z.array(z.string()),
});

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ source, eventName, payload, account, kinds }) => {
      const adapter = adapterOf(source);
      try {
        const data = await adapter?.normalize(liveWatchEnv(deps), {
          eventName,
          payload,
          account,
          kinds,
        });
        if (data) return { status: "ok", data };
      } catch (error) {
        // A read the event needed failed: the follower tries it again.
        return { status: "error", error: error instanceof Error ? error.message : String(error) };
      }
      return { status: "error", error: `Rome cannot read ${eventName} for "${source}".` };
    },
  });
}
