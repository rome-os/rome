import { Hono } from "hono";
import type { VoiceInputInfo } from "@rome/api-types/voice-input";
import type { ApiDeps } from "../deps.js";

export function voiceInputRoutes(deps: Pick<ApiDeps, "transcriber">): Hono {
  const app = new Hono();
  app.get("/voice-input", (c) => {
    const body: VoiceInputInfo = { place: deps.transcriber?.place ?? null };
    return c.json(body);
  });
  return app;
}
