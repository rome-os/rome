import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { composioActionError, loadConnectorClient } from "../../shared.js";

const log = createAppLogger("connector_event_search");

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe("Toolkit slug to list triggers for, e.g. 'gmail', 'github', 'slack'"),
  regex: z
    .string()
    .optional()
    .describe(
      "Case-insensitive regex to filter triggers by slug/name/description; omit to list all",
    ),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ toolkit, regex }) => {
      let filter: RegExp | undefined;
      if (regex != null) {
        try {
          filter = new RegExp(regex, "i");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { status: "error", error: `Invalid regex "${regex}": ${message}` };
        }
      }

      const client = await loadConnectorClient();
      if (!client) {
        return {
          status: "error",
          error:
            "Not signed in to Composio. Call connector_login once to sign in, then re-run connector_event_search.",
        };
      }
      try {
        let events = await client.listTriggerTypes(toolkit);
        if (filter) {
          const f = filter;
          events = events.filter((e) => f.test(e.slug) || f.test(e.name) || f.test(e.description));
        }
        return { status: "ok", data: { events, count: events.length } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("event search failed", { toolkit, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            "Composio trigger search failed",
            "connector_event_search",
          ),
        };
      }
    },
  });
}
