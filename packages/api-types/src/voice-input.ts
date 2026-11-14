// Voice input: the read API that names where speech becomes text, and the
// messages of the dictation socket at `/ws/voice-input`. The dashboard uses
// both today; the desktop and iOS apps are meant to use the same socket.

import { z } from "zod";

/** `GET /api/voice-input`. `place` is null when the instance has no transcription provider. */
export const voiceInputInfoSchema = z.object({
  place: z
    .object({
      /** The provider's name, such as "Soniox". */
      provider: z.string(),
      /** The host Rome sends the audio to. */
      host: z.string(),
    })
    .nullable(),
});
export type VoiceInputInfo = z.infer<typeof voiceInputInfoSchema>;

export const VOICE_INPUT_SOCKET_PATH = "/ws/voice-input";

/** The audio a client sends after `start`: raw PCM, signed 16-bit little-endian, mono. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;

/**
 * What a client sends as text frames. `start` comes first, then binary audio
 * frames, then `stop`. After `stop` Rome sends the rest of the text and then
 * `ended`.
 */
export const voiceInputClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), sampleRate: z.number().int().min(8_000).max(48_000) }),
  z.object({ type: z.literal("stop") }),
]);
export type VoiceInputClientMessage = z.infer<typeof voiceInputClientMessageSchema>;

/** Why listening stopped without the guardian's stop action. */
export const voiceInputStopReasonSchema = z.enum([
  /** The provider could not be reached or closed the stream early. */
  "provider-unavailable",
  /** The provider refused Rome's credential or the request. */
  "provider-refused",
  /** The client broke the socket's message order. */
  "bad-request",
  /** One dictation reached Rome's length limit; the text heard so far still arrives. */
  "time-limit",
]);
export type VoiceInputStopReason = z.infer<typeof voiceInputStopReasonSchema>;

/**
 * What Rome sends. Each `text` carries the text that became settled since the
 * last one, to append, and the whole unsettled tail, which replaces the
 * previous tail. `ended` closes a stream that the client stopped; `error`
 * closes one that stopped for `reason`. Nothing follows either.
 */
export const voiceInputServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), settled: z.string(), pending: z.string() }),
  z.object({ type: z.literal("ended") }),
  z.object({ type: z.literal("error"), reason: voiceInputStopReasonSchema }),
]);
export type VoiceInputServerMessage = z.infer<typeof voiceInputServerMessageSchema>;
