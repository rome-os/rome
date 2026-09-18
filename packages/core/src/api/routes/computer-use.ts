import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";

export function computerUseRoutes(deps: Pick<ApiDeps, "computerUse">): Hono {
  const app = new Hono();
  app.get("/computer-use", async (c) => c.json(await deps.computerUse.getStatus()));
  return app;
}
