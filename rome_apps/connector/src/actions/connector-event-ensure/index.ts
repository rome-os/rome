import {
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";
import { liveWatchEnv } from "../../watch/env.js";
import { adapterForEvent, deliveredEvents } from "../../watch/registry.js";

const inputSchema = z.object({
  eventName: z
    .string()
    .trim()
    .min(1)
    .describe("Bus event name, e.g. 'provider:event:github.workflow_run'"),
  filter: z
    .array(z.object({ field: z.string().min(1), equals: z.string() }))
    .default([])
    .describe("The wait's equality conditions; one must name the repo or org"),
  dryRun: z
    .boolean()
    .default(false)
    .describe("Only check: return active | inactive and change nothing"),
});

export function createAction(config: ActionConfig, deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ eventName, filter, dryRun }) => {
      const adapter = adapterForEvent(eventName);
      if (!adapter) {
        const [first, ...rest] = deliveredEvents();
        return {
          status: "error",
          error: `connector_event_ensure handles ${first} and ${rest.join(", ")} events only, not "${eventName}"`,
        };
      }
      const result = await adapter.ensureEvent(liveWatchEnv(deps), { eventName, filter, dryRun });
      // A check answers active | inactive; a subscribe answers existing | created.
      return result.ok
        ? { status: "ok", data: { subscription: result.subscription } }
        : { status: "error", error: result.error };
    },
  });
}
