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
import type { Transcriber, TranscriptionFailure, TranscriptionStream } from "./transcriber.js";

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
 * Serves `/ws/voice-input` to whoever may use the dashboard. Without a
 * transcriber the path answers 404, as the voice control is then absent.
 */
export function attachVoiceInputServer(
  httpServer: Server,
  db: DrizzleDb,
  transcriber: Transcriber | null,
  dashboardAccess?: Pick<DashboardAccessState, "isCloudEmailAllowed">,
): { close(): void } {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  httpServer.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== VOICE_INPUT_SOCKET_PATH) return;
    socket.on("error", () => socket.destroy());
    if (!transcriber) {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    void gateUpgrade(req, socket, db, dashboardAccess)
      .then((caller) => {
        if (!caller || socket.destroyed) return;
        wss.handleUpgrade(req, socket, head, (ws) => serve(ws, transcriber));
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

/** Runs one dictation over `ws`. Exported for tests. */
export function serve(
  ws: WebSocket,
  transcriber: Transcriber,
  maxDictationMs = MAX_DICTATION_MS,
  finishTimeoutMs = FINISH_TIMEOUT_MS,
): void {
  let stream: TranscriptionStream | null = null;
  let closed = false;
  let timedOut = false;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let finishing: ReturnType<typeof setTimeout> | null = null;
  let frames = 0;
  let bytes = 0;

  const reply = (message: VoiceInputServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const close = (last: VoiceInputServerMessage) => {
    if (closed) return;
    closed = true;
    if (limit) clearTimeout(limit);
    if (finishing) clearTimeout(finishing);
    reply(last);
    ws.close(1000);
    log.info("voice input stopped", { outcome: last.type, frames, bytes });
  };

  ws.on("message", (data: RawData, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (!stream) return close({ type: "error", reason: "bad-request" });
      const chunk = toBytes(data);
      frames += 1;
      bytes += chunk.byteLength;
      stream.sendAudio(chunk);
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
      if (stream) return close({ type: "error", reason: "bad-request" });
      log.info("voice input started", {
        provider: transcriber.place.provider,
        sampleRate: message.data.sampleRate,
      });
      stream = transcriber.open(
        { sampleRate: message.data.sampleRate },
        {
          onText: (settled, pending) => {
            if (!closed) reply({ type: "text", settled, pending });
          },
          onEnd: () =>
            close(timedOut ? { type: "error", reason: "time-limit" } : { type: "ended" }),
          onFailure: (failure, detail) => {
            log.warn("voice input provider failed", { failure, detail });
            close({ type: "error", reason: STOP_REASON[failure] });
          },
        },
      );
      limit = setTimeout(() => {
        timedOut = true;
        finish();
      }, maxDictationMs);
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
    if (limit) clearTimeout(limit);
    if (finishing) clearTimeout(finishing);
    if (!closed) {
      closed = true;
      log.info("voice input stopped", { outcome: "client-closed", frames, bytes });
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
