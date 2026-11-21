import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";
import { NO_VOICE_INPUT } from "../../voice-input/index.js";

export function voiceInputRoutes(deps: Pick<ApiDeps, "voiceInput">): Hono {
  const app = new Hono();
  app.get("/voice-input", async (c) => c.json(await (deps.voiceInput ?? NO_VOICE_INPUT).info()));
  return app;
}
