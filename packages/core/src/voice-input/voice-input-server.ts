// The dictation socket: the client streams microphone audio to Rome, Rome
// relays it to the transcriber and streams the text back. Messages are in
// `@rome/api-types/voice-input`. Rome keeps no audio: frames go straight to
// the provider and only their count and size reach the log.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import {
  VOICE_INPUT_SOCKET_PATH,
  type VoiceInputServerMessage,
  type VoiceInputStopReason,
  voiceInputClientMessageSchema,
} from "@rome/api-types/voice-input";
import type { DrizzleDb } from "../db/index.js";
import { gateUpgrade } from "../access/ws-guardian-gate.js";
import type { DashboardAccessState } from "../access/dashboard-access-state.js";
import { rejectUpgrade } from "../lib/ws-upgrade.js";
import { createLogger } from "../logger.js";
import type { TranscriptionUsageSink } from "../usage/recorder.js";
import type { TranscriptionFailure, TranscriptionStream } from "./transcriber.js";
import type { ListeningSource, VoiceInputSource } from "./voice-input-source.js";

const log = createLogger("voice-input");

// A 16 kHz mono frame of a few hundred milliseconds is about 10 KB.
const MAX_FRAME_BYTES = 256 * 1024;

// Bounds what one forgotten open microphone costs on the provider's bill.
export const MAX_DICTATION_MS = 10 * 60 * 1000;

// How long the provider has to send the rest of the text once asked.
export const FINISH_TIMEOUT_MS = 5_000;

const STOP_REASON: Record<TranscriptionFailure, VoiceInputStopReason> = {
  unavailable: "provider-unavailable",
  refused: "provider-refused",
};

/**
 * Serves `/ws/voice-input` to whoever may use the dashboard. Without any
 * source of transcription the path answers 404, as the voice control is then
 * absent.
 */
export function attachVoiceInputServer(
  httpServer: Server,
  db: DrizzleDb,
  source: VoiceInputSource,
  usage: TranscriptionUsageSink | null,
  dashboardAccess?: Pick<DashboardAccessState, "isCloudEmailAllowed">,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== VOICE_INPUT_SOCKET_PATH) return;
    socket.on("error", () => socket.destroy());
    if (!source.available()) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    void gateUpgrade(req, socket, db, dashboardAccess)
      .then((caller) => {
        if (!caller || socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, { source, usage }));
      })
      .catch((err) => {
        log.error("voice input upgrade failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        rejectUpgrade(socket, 500, "Internal Server Error");
      });
  });

  return {
    close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}

export interface ServeOptions {
  source: Pick<VoiceInputSource, "open">;
  usage?: TranscriptionUsageSink | null;
  maxDictationMs?: number;
  finishTimeoutMs?: number;
}

/** Runs one dictation over `ws`. Exported for tests. */
export function serve(ws: WebSocket, options: ServeOptions): void {
  const maxDictationMs = options.maxDictationMs ?? MAX_DICTATION_MS;
  const finishTimeoutMs = options.finishTimeoutMs ?? FINISH_TIMEOUT_MS;
  let stream: TranscriptionStream | null = null;
  let listening: { source: ListeningSource; sampleRate: number; startedAt: number } | null = null;
  // Between `start` and the transcriber opening: audio waits here, in order.
  let starting = false;
  const early: Uint8Array[] = [];
  let stopAsked = false;
  let closed = false;
  let timedOut = false;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let finishing: ReturnType<typeof setTimeout> | null = null;
  let frames = 0;
  let bytes = 0;

  const reply = (message: VoiceInputServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const settle = (outcome: string) => {
    if (limit) clearTimeout(limit);
    if (finishing) clearTimeout(finishing);
    log.info("voice input stopped", { outcome, frames, bytes });
    reportUsage(outcome);
  };
  const close = (last: VoiceInputServerMessage) => {
    if (closed) return;
    closed = true;
    reply(last);
    ws.close(1000);
    settle(last.type === "error" ? last.reason : last.type);
  };

  // Usage is reported only for a Rome Cloud session: Rome Cloud does not
  // count what the instance's own provider served.
  function reportUsage(status: string) {
    const sessionId = listening?.source.romeCloudSessionId;
    if (!listening || !sessionId || !options.usage) return;
    const { transcriber } = listening.source;
    options.usage.recordTranscription({
      sessionId,
      provider: transcriber.place.provider.toLowerCase(),
      model: transcriber.model,
      // PCM s16le mono: two bytes a sample.
      seconds: Math.round((bytes / 2 / listening.sampleRate) * 10) / 10,
      status,
      durationMs: Date.now() - listening.startedAt,
    });
  }

  const sendAudio = (chunk: Uint8Array) => {
    frames += 1;
    bytes += chunk.byteLength;
    stream?.sendAudio(chunk);
  };

  async function begin(sampleRate: number) {
    starting = true;
    const opened = await options.source.open();
    starting = false;
    if (closed) return;
    if (!opened.ok) {
      close({ type: "error", reason: opened.reason, detail: opened.detail });
      return;
    }
    const { transcriber } = opened.source;
    listening = { source: opened.source, sampleRate, startedAt: Date.now() };
    log.info("voice input started", {
      provider: transcriber.place.provider,
      via: opened.source.romeCloudSessionId ? "rome-cloud" : "instance",
      sampleRate,
    });
    stream = transcriber.open(
      { sampleRate },
      {
        onText: (settled, pending) => {
          if (!closed) reply({ type: "text", settled, pending });
        },
        onEnd: () => close(timedOut ? { type: "error", reason: "time-limit" } : { type: "ended" }),
        onFailure: (failure, detail) => {
          log.warn("voice input provider failed", { failure, detail });
          close({ type: "error", reason: STOP_REASON[failure] });
        },
      },
    );
    for (const chunk of early.splice(0)) sendAudio(chunk);
    limit = setTimeout(() => {
      timedOut = true;
      finish();
    }, maxDictationMs);
    if (stopAsked) finish();
  }

  ws.on("message", (data: RawData, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (starting) {
        early.push(toBytes(data));
        return;
      }
      if (!stream) return close({ type: "error", reason: "bad-request" });
      sendAudio(toBytes(data));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return close({ type: "error", reason: "bad-request" });
    }
    const message = voiceInputClientMessageSchema.safeParse(parsed);
    if (!message.success) return close({ type: "error", reason: "bad-request" });
    if (message.data.type === "start") {
      if (stream || starting) return close({ type: "error", reason: "bad-request" });
      void begin(message.data.sampleRate).catch((err: unknown) => {
        log.error("voice input could not start", {
          error: err instanceof Error ? err.message : String(err),
        });
        close({ type: "error", reason: "provider-unavailable" });
      });
      return;
    }
    if (starting) {
      stopAsked = true;
      return;
    }
    if (!stream) return close({ type: "error", reason: "bad-request" });
    finish();
  });

  // Asks the provider for the rest of the text, and gives up on a provider
  // that never answers.
  function finish() {
    if (!stream || finishing) return;
    stream.finish();
    finishing = setTimeout(() => {
      stream?.abort();
      close({ type: "error", reason: timedOut ? "time-limit" : "provider-unavailable" });
    }, finishTimeoutMs);
  }

  ws.on("close", () => {
    if (!closed) {
      closed = true;
      settle("client-closed");
    }
    stream?.abort();
  });
  ws.on("error", () => ws.terminate());
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}
