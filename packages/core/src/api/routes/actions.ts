import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";

/** One catalog entry of `GET /actions`. Mirrors what the agent-facing
 * `list_actions`/`read_action` MCP tools expose, shaped for dashboard pickers:
 * the summary fields plus visibility and the full JSON Schema (`inputSchema`)
 * so the client can render argument help and validate args before submitting.
 * `inputSchema` is `null` for event-only actions (workflows), which declare no
 * schema but are still bindable by name (e.g. from a routine). */
export interface ActionCatalogEntry {
  name: string;
  description: string;
  type: "system" | "custom";
  visibility: "public" | "explicit";
  sideEffects: "read-only" | "write";
  requiresApproval: boolean;
  ownerType: string;
  ownerId: string;
  inputSchema: Record<string, unknown> | null;
}

export function actionsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // GET /actions — the live action catalog. Reads the registry on every
  // request (never a snapshot) so actions registered or removed mid-process —
  // e.g. by an app install — are immediately visible to pickers such as the
  // routine-creation modal.
  app.get("/actions", (c) => {
    const actions = deps.actionRegistry
      .list()
      .flatMap((name): ActionCatalogEntry[] => {
        const action = deps.actionRegistry.get(name);
        if (!action) return [];
        const metadata = deps.actionRegistry.getMetadata(name);
        return [
          {
            name,
            description: action.config.description,
            type: action.config.type,
            visibility: action.config.visibility ?? "public",
            sideEffects: action.config.sideEffects,
            requiresApproval: !!action.config.requiresApproval,
            ownerType: metadata?.ownerType ?? "core",
            ownerId: metadata?.ownerId ?? "core",
            inputSchema: action.inputSchema ?? null,
          },
        ];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    // The registry is live and this powers an interactive picker — never let
    // an intermediary cache serve a stale catalog.
    c.header("Cache-Control", "no-store");
    return c.json({ actions });
  });

  app.post("/actions/executions/:id/cancel", async (c) => {
    const rootExecutionId = c.req.param("id");
    const cancelled = await deps.actionEngine.cancel(rootExecutionId);
    if (!cancelled) {
      return c.json({ error: "Execution not running" }, 404);
    }
    return c.json({ ok: true, rootExecutionId }, 202);
  });

  return app;
}
