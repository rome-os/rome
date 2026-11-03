import {
  createAppLogger,
  defineAction,
  z,
  type Action,
  type ActionConfig,
  type AppActionRuntimeDeps,
} from "@rome-os/app-runtime";

import {
  composioActionError,
  isSupportedToolkit,
  loadConnectorClient,
  unsupportedToolkitHint,
} from "../../shared.js";

const log = createAppLogger("connector_search");

/**
 * Keep only tools whose toolkit Rome can actually connect (the supported
 * catalog), then trim to `limit`. Composio's tool search ranks across its entire
 * catalog, including toolkits Rome can't OAuth into — surfacing those lets the
 * agent propose a tool the owner can never authorize. Filtering at the search
 * boundary is the single place that decides what's reachable, so a dead-end
 * toolkit never reaches the agent. Pure over the tool list for fixture testing.
 */
export function selectSupportedTools<T extends { toolkitSlug: string }>(
  tools: T[],
  limit: number,
): T[] {
  return tools.filter((tool) => isSupportedToolkit(tool.toolkitSlug)).slice(0, limit);
}

const inputSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Capability to search for, e.g. 'create a github issue', 'run a supabase query', 'list neon branches'",
    ),
  toolkit: z
    .string()
    .optional()
    .describe("Restrict the search to one toolkit slug, e.g. 'github', 'supabase', 'neon'"),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Max tools to return (default 10)"),
});

export function createAction(config: ActionConfig, _deps: AppActionRuntimeDeps): Action {
  return defineAction({
    config,
    schema: inputSchema,
    execute: async ({ query, toolkit, limit }) => {
      // Scoping the search to a toolkit Rome can't connect can only return tools
      // the owner could never authorize — reject up front with the same guidance
      // connector_connect gives, rather than silently returning an empty list.
      if (toolkit && !isSupportedToolkit(toolkit)) {
        return { status: "error", error: unsupportedToolkitHint(toolkit) };
      }
      const client = await loadConnectorClient();
      if (!client) {
        return {
          status: "error",
          error:
            "Not signed in to Composio. Call connector_login once to sign in, then re-run connector_search.",
        };
      }
      const requested = limit ?? 10;
      try {
        // Over-fetch the ranked page so filtering out unsupported toolkits still
        // yields up to `requested` tools when enough supported matches exist; the
        // candidate pool is capped to keep the search responsive.
        const candidates = await client.searchTools({
          query,
          toolkit,
          limit: Math.min(50, requested * 5),
        });
        const tools = selectSupportedTools(candidates, requested);
        return { status: "ok", data: { tools, count: tools.length } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("tool search failed", { query, toolkit, error: message });
        return {
          status: "error",
          error: await composioActionError(
            client,
            err,
            "Composio tool search failed",
            "connector_search",
          ),
        };
      }
    },
  });
}
