import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { buildTopic } from "../../api/topic.js";
import { composioActionError, loadConnectorClient } from "../../shared.js";

const log = createAppLogger("connector_event_schema");

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe("Owning toolkit slug of the trigger, e.g. 'gmail', 'github', 'slack'"),
  slug: z
    .string()
    .min(1)
    .describe(
      "Trigger slug to fetch the schema for, e.g. 'GMAIL_NEW_GMAIL_MESSAGE' (from connector_event_search)",
    ),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ toolkit, slug }) => {
      const client = await loadConnectorClient();
      if (!client) {
        return {
          status: "error",
          error: `Not signed in to Composio. Call connector_login once to sign in, then re-run connector_event_schema for "${slug}".`,
        };
      }
      try {
        const schema = await client.getTriggerSchema(slug);
        // The retrieve response carries the authoritative owning toolkit; reject a
        // mismatch loudly rather than return a schema for a different toolkit than
        // the caller declared (mirrors connector_tool_schema).
        if (schema.toolkitSlug.toLowerCase() !== toolkit.toLowerCase()) {
          return {
            status: "error",
            error: `Trigger "${slug}" belongs to toolkit "${schema.toolkitSlug}", not "${toolkit}". Re-run with the correct toolkit.`,
          };
        }
        return {
          status: "ok",
          data: {
            slug: schema.slug,
            name: schema.name,
            description: schema.description,
            config: schema.config,
            payload: schema.payload,
            eventName: buildTopic(schema.toolkitSlug, schema.slug),
            requiresWebhookEndpointSetup: schema.requiresWebhookEndpointSetup,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("event schema fetch failed", { slug, toolkit, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            "Composio trigger schema fetch failed",
            `connector_event_schema for "${slug}"`,
          ),
        };
      }
    },
  });
}
