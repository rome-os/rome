import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import { composioActionError, loadConnectorClient } from "../../shared.js";

const log = createAppLogger("connector_tool_schema");

const inputSchema = z.object({
  toolkit: z
    .string()
    .min(1)
    .describe("Owning toolkit slug of the tool, e.g. 'gmail', 'github', 'slack'"),
  slug: z
    .string()
    .min(1)
    .describe("Tool slug to fetch the schema for, e.g. 'GMAIL_SEND_EMAIL' (from connector_search)"),
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
          error: `Not signed in to Composio. Call connector_login once to sign in, then re-run connector_tool_schema for "${slug}".`,
        };
      }
      try {
        const schema = await client.getToolSchema(slug);
        // The slug already encodes a toolkit, but deriving the owner by splitting
        // the slug prefix breaks on multi-word toolkits (MICROSOFT_TEAMS). The
        // retrieve response carries the authoritative owner, so cross-check the
        // declared toolkit against it and reject a mismatch loudly rather than
        // hand back a schema for a different toolkit than the caller asked for.
        if (schema.toolkitSlug.toLowerCase() !== toolkit.toLowerCase()) {
          return {
            status: "error",
            error: `Tool "${slug}" belongs to toolkit "${schema.toolkitSlug}", not "${toolkit}". Re-run with the correct toolkit.`,
          };
        }
        return {
          status: "ok",
          data: {
            slug: schema.slug,
            name: schema.name,
            description: schema.description,
            input: schema.input,
            output: schema.output,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("tool schema fetch failed", { slug, toolkit, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            "Composio tool schema fetch failed",
            `connector_tool_schema for "${slug}"`,
          ),
        };
      }
    },
  });
}
