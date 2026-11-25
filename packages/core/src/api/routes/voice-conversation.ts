import { Hono } from "hono";
import {
  type VoiceConversationInfo,
  voiceConversationPreviewSchema,
  voiceConversationSettingsSchema,
} from "@rome/api-types/voice-conversation";
import { currentSessionActor } from "../../access/session-actor.js";
import { isOnTeam } from "../../access/team.js";
import { NO_VOICE_INPUT } from "../../voice-input/index.js";
import { speakSample } from "../../voice-output/speak-sample.js";
import {
  readSpeakingSettings,
  VOICE_SPEAKING_SETTING_KEY,
} from "../../voice-output/speaking-settings.js";
import type { ApiDeps } from "../deps.js";

// What a preview says, in the language Settings shows.
const SAMPLE = {
  zh: "你好，我是 Rome。今天想聊点什么？",
  en: "Hi, I'm Rome. What would you like to talk about today?",
} as const;

/**
 * Whether the dashboard offers a voice conversation to the caller. It follows
 * the microphone exactly: Rome Cloud lets the guardian's account use voice input.
 * Settings picks the voice it speaks in and how fast, and can hear a voice first.
 */
export function voiceConversationRoutes(
  deps: Pick<ApiDeps, "voiceInput" | "speaker" | "dashboardAccessState" | "settingsRepo">,
): Hono {
  const app = new Hono();
  const available = async () =>
    Boolean(deps.speaker) &&
    isOnTeam(await currentSessionActor(), deps.dashboardAccessState) &&
    (await (deps.voiceInput ?? NO_VOICE_INPUT).info()).available;

  app.get("/voice-conversation", async (c) => {
    return c.json({ available: await available() } satisfies VoiceConversationInfo);
  });

  app.get("/voice-conversation/settings", async (c) => {
    if (!isOnTeam(await currentSessionActor(), deps.dashboardAccessState)) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(await readSpeakingSettings(deps.settingsRepo));
  });

  app.put("/voice-conversation/settings", async (c) => {
    if (!isOnTeam(await currentSessionActor(), deps.dashboardAccessState)) {
      return c.json({ error: "Not found" }, 404);
    }
    const parsed = voiceConversationSettingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Pick a listed voice and a speed from 0.7 to 1.3" }, 400);
    await deps.settingsRepo.set(VOICE_SPEAKING_SETTING_KEY, parsed.data);
    return c.json(parsed.data);
  });

  app.post("/voice-conversation/preview", async (c) => {
    if (!deps.speaker || !(await available())) return c.json({ error: "Not found" }, 404);
    const parsed = voiceConversationPreviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: "Pick a listed voice and a speed from 0.7 to 1.3" }, 400);
    const { voice, speed, language } = parsed.data;
    const audio = await speakSample(deps.speaker, { voice, speed, language }, SAMPLE[language]);
    if (!audio) return c.json({ error: "The voice could not be played" }, 502);
    return new Response(audio, {
      headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store" },
    });
  });
  return app;
}
