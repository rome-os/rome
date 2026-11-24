import { Hono } from "hono";
import type { VoiceConversationInfo } from "@rome/api-types/voice-conversation";
import { isGuardianSession } from "../../access/session-actor.js";
import { NO_VOICE_INPUT } from "../../voice-input/index.js";
import { resolveVoiceModeEnabled } from "../../voice-output/voice-mode-gate.js";
import type { ApiDeps } from "../deps.js";

/** Whether the guardian's dashboard offers a voice conversation: `voice_mode` on, and Rome able to listen and speak. */
export function voiceConversationRoutes(
  deps: Pick<ApiDeps, "voiceInput" | "speaker">,
  enabled: () => Promise<boolean> = resolveVoiceModeEnabled,
): Hono {
  const app = new Hono();
  app.get("/voice-conversation", async (c) => {
    const available =
      Boolean(deps.speaker) &&
      (deps.voiceInput ?? NO_VOICE_INPUT).available() &&
      (await isGuardianSession()) &&
      (await enabled());
    return c.json({ available } satisfies VoiceConversationInfo);
  });
  return app;
}
