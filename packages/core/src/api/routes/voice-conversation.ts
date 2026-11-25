import { Hono } from "hono";
import type { VoiceConversationInfo } from "@rome/api-types/voice-conversation";
import { NO_VOICE_INPUT } from "../../voice-input/index.js";
import type { ApiDeps } from "../deps.js";

/**
 * Whether the dashboard offers a voice conversation to the caller. It follows
 * the microphone exactly: Rome Cloud lets the guardian's account use voice input.
 */
export function voiceConversationRoutes(deps: Pick<ApiDeps, "voiceInput" | "speaker">): Hono {
  const app = new Hono();
  app.get("/voice-conversation", async (c) => {
    const available =
      Boolean(deps.speaker) && (await (deps.voiceInput ?? NO_VOICE_INPUT).info()).available;
    return c.json({ available } satisfies VoiceConversationInfo);
  });
  return app;
}
