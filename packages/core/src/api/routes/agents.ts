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
    const records = deps.agentLoader.getAllRecords();
    const agents = Array.from(records.entries()).map(([name, record]) => ({
      name,
      localName: record.config.name,
      description: record.config.description,
      ownerType: record.metadata.ownerType,
      ownerId: record.metadata.ownerId,
    }));
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ agents });
  });

  return app;
}
