import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";

/**
 * Lists agents currently loaded in the catalog so dashboard/slash-command
 * surfaces can offer them as routing targets (e.g. binding a Discord channel
 * to an app-declared agent). Returns name + owner so the UI can disambiguate
 * core agents from app-shipped ones.
 */
export function agentsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/agents", async (c) => {
    const agents = deps.agentLoader.list().map((agent) => ({
      name: agent.name,
      localName: agent.localName,
      description: agent.definition.description,
      ownerType: agent.ownerType,
      ownerId: agent.ownerId,
    }));
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ agents });
  });

  return app;
}
