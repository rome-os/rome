// Voice conversation: the messages of the socket at `/ws/voice-conversation`.
// The client only records and plays: it streams microphone audio up, and Rome
// listens, sends each turn to the chat's agent, and streams the spoken reply
// down. The same socket is meant for the web dashboard and the iOS app.

import { z } from "zod";

export const VOICE_CONVERSATION_SOCKET_PATH = "/ws/voice-conversation";

/**
 * `GET /api/voice-conversation`. `available` is true only for the guardian,
 * and only while Rome Cloud lets their account use voice input, as the
 * microphone shows. A client offers the voice conversation button only then,
 * and only in a Concierge chat.
 */
export const voiceConversationInfoSchema = z.object({ available: z.boolean() });
export type VoiceConversationInfo = z.infer<typeof voiceConversationInfoSchema>;

/**
 * What a client sends as text frames. `start` comes first and names the chat
 * to talk in, then binary audio frames: raw PCM, signed 16-bit little-endian,
 * mono, at `sampleRate`. `stop` ends the conversation.
 */
export const voiceConversationClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    chatId: z.string().min(1).max(128),
    sampleRate: z.number().int().min(8_000).max(48_000),
  }),
  z.object({ type: z.literal("stop") }),
]);
export type VoiceConversationClientMessage = z.infer<typeof voiceConversationClientMessageSchema>;

/**
 * `listening`: Rome waits for the guardian. `thinking`: the agent works on
 * their turn and nothing plays. `speaking`: the reply's audio plays, as far as
 * Rome can tell from what it sent.
 */
export const voiceConversationStateSchema = z.enum(["listening", "thinking", "speaking"]);
export type VoiceConversationState = z.infer<typeof voiceConversationStateSchema>;

/** Why a conversation ended without the client's `stop`. */
export const voiceConversationStopReasonSchema = z.enum([
  /** Voice conversation mode is off, or speaking is not set up. */
  "unavailable",
  /** Rome could not listen: the transcription provider or Rome Cloud failed or refused. */
  "listening-failed",
  /** Rome could not speak: the speech provider or its credential failed. */
  "speaking-failed",
  /** The chat could not take the turn: one the speaker may not open, or whose agent could not start. */
  "chat-refused",
  /** The listening session reached its time limit. */
  "time-limit",
  /** The client broke the socket's message order. */
  "bad-request",
]);
export type VoiceConversationStopReason = z.infer<typeof voiceConversationStopReasonSchema>;

/** How often Rome says it is still there, so a client notices a dead connection. */
export const VOICE_CONVERSATION_ALIVE_INTERVAL_MS = 1_000;

/**
 * What Rome sends as text frames. Binary frames are the reply's audio: raw PCM,
 * signed 16-bit little-endian, mono, at the `ready` sample rate, in the order
 * to play them.
 *
 * - `ready`: listening has started. The audio Rome sends has this rate.
 * - `state`: the conversation's state changed.
 * - `heard`: the guardian's turn so far: `settled` text and the unsettled `pending` tail.
 * - `turn`: the guardian finished a turn, and Rome sent `text` to the chat as the message `inputId`.
 * - `caption`: the next sentence of the reply, sent before its audio. Plain text, never HTML: show it as text.
 * - `clear`: the guardian spoke over the reply: drop the audio not played yet.
 * - `alive`: every `VOICE_CONVERSATION_ALIVE_INTERVAL_MS`.
 * - `ended` closes a conversation the client stopped. `error` closes one that stopped for `reason`.
 */
export const voiceConversationServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), sampleRate: z.number().int() }),
  z.object({ type: z.literal("state"), state: voiceConversationStateSchema }),
  z.object({ type: z.literal("heard"), settled: z.string(), pending: z.string() }),
  z.object({ type: z.literal("turn"), text: z.string(), inputId: z.string() }),
  z.object({ type: z.literal("caption"), text: z.string() }),
  z.object({ type: z.literal("clear") }),
  z.object({ type: z.literal("alive") }),
  z.object({ type: z.literal("ended") }),
  z.object({ type: z.literal("error"), reason: voiceConversationStopReasonSchema }),
]);
export type VoiceConversationServerMessage = z.infer<typeof voiceConversationServerMessageSchema>;
