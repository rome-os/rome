// The dictation socket: the client streams microphone audio to Rome, Rome
// relays it to the transcriber and streams the text back. Messages are in
// `@rome/api-types/voice-input`. Rome keeps no audio: frames go straight to
// the provider and only their count and size reach the log.

import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import {
  VOICE_INPUT_ALIVE_INTERVAL_MS,
  VOICE_INPUT_QUIET_LIMIT_MS,
  VOICE_INPUT_SOCKET_PATH,
  type VoiceInputServerMessage,
  type VoiceInputStopReason,
  voiceInputClientMessageSchema,
} from "@rome/api-types/voice-input";
import type { DrizzleDb } from "../db/index.js";
import { mayEnter, holdEntry } from "../access/entry.js";
import type { DashboardAllowList } from "../access/team.js";
import { gateUpgrade } from "../access/ws-guardian-gate.js";
import { rejectUpgrade } from "../lib/ws-upgrade.js";
import { createLogger } from "../logger.js";
import type { TranscriptionUsageSink } from "../usage/recorder.js";
import { createFillerFilter } from "./filler-words.js";
import type { TranscriptionFailure, TranscriptionStream } from "./transcriber.js";
import type { ListeningSource, VoiceInputSource } from "./voice-input-source.js";
import { readVoiceTerms } from "./voice-terms.js";

const log = createLogger("voice-input");

// A 16 kHz mono frame of a few hundred milliseconds is about 10 KB.
const MAX_FRAME_BYTES = 256 * 1024;

// Bounds what one forgotten open microphone costs on the provider's bill.
export const MAX_DICTATION_MS = 10 * 60 * 1000;

// How long the provider has to send the rest of the text once asked.
export const FINISH_TIMEOUT_MS = 5_000;

// How long a stopped dictation waits for its source to open. Longer than the
// Rome Cloud session request's own timeout, so Rome Cloud answers first.
export const OPEN_TIMEOUT_MS = 12_000;

// A microphone delivers audio no faster than real time. The slack covers
// frames that arrive in a burst after a network stall.
const AUDIO_SLACK_MS = 5_000;
// The most audio a client may say it recorded before its socket opened.
const MAX_BUFFERED_MS = 15_000;

const CLOSE_POLICY_VIOLATION = 1008;

const STOP_REASON: Record<TranscriptionFailure, VoiceInputStopReason> = {
  unavailable: "provider-unavailable",
  refused: "provider-refused",
  // Rome Cloud's credential lives as long as one dictation may.
  expired: "time-limit",
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
  dashboardAccess: DashboardAllowList,
  voiceTerms: () => Promise<string[]> = readVoiceTerms,
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
      .then((actor) => {
        if (!actor || socket.destroyed) return;
        const mayStillEnter = async () => (await mayEnter(actor, dashboardAccess)) !== null;
        wss.handleUpgrade(req, socket, head, (ws) =>
          serve(ws, { source, usage, voiceTerms, mayStillEnter }),
        );
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
  voiceTerms?: () => Promise<string[]>;
  source: Pick<VoiceInputSource, "open">;
  usage?: TranscriptionUsageSink | null;
  maxDictationMs?: number;
  finishTimeoutMs?: number;
  openTimeoutMs?: number;
  quietLimitMs?: number;
  /**
   * Whether the person on the socket may still enter. Once it answers false
   * the dictation ends and takes no more audio. Default: always.
   */
  mayStillEnter?: () => Promise<boolean>;
}

/** Runs one dictation over `ws`. Exported for tests. */
export function serve(ws: WebSocket, options: ServeOptions): void {
  const maxDictationMs = options.maxDictationMs ?? MAX_DICTATION_MS;
  const finishTimeoutMs = options.finishTimeoutMs ?? FINISH_TIMEOUT_MS;
  const openTimeoutMs = options.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const quietLimitMs = options.quietLimitMs ?? VOICE_INPUT_QUIET_LIMIT_MS;
  let stream: TranscriptionStream | null = null;
  let listening: { source: ListeningSource; sampleRate: number; startedAt: number } | null = null;
  // Between `start` and the transcriber opening: audio waits here, in order.
  let starting = false;
  const early: Uint8Array[] = [];
  let stopAsked = false;
  let closed = false;
  // Why Rome itself stopped listening, sent once the rest of the text is in.
  let stoppedFor: VoiceInputStopReason | null = null;
  let limit: ReturnType<typeof setTimeout> | null = null;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let finishing: ReturnType<typeof setTimeout> | null = null;
  let opening: ReturnType<typeof setTimeout> | null = null;
  let alive: ReturnType<typeof setInterval> | null = null;
  let finishAsked = false;
  let frames = 0;
  let bytes = 0;
  // When `start` arrived and at what rate, to hold audio to real time.
  let pace: { since: number; sampleRate: number } | null = null;
  // When the source opened, the client asked to stop, and how much audio
  // waited for the source: what the log needs to tell where time and audio went.
  let openedAt: number | null = null;
  let stopAt: number | null = null;
  let earlyBytes = 0;

  const entry = holdEntry(options.mayStillEnter ?? (async () => true), () => {
    if (closed) return;
    closed = true;
    ws.close(CLOSE_POLICY_VIOLATION, "Forbidden");
    settle("may-not-enter");
    stream?.abort();
  });

  const reply = (message: VoiceInputServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const settle = (outcome: string) => {
    entry.release();
    if (limit) clearTimeout(limit);
    if (quiet) clearTimeout(quiet);
    if (finishing) clearTimeout(finishing);
    if (opening) clearTimeout(opening);
    if (alive) clearInterval(alive);
    const since = pace?.since ?? Date.now();
    log.info("voice input stopped", {
      sessionId: listening?.source.romeCloudSessionId ?? null,
      outcome,
      frames,
      bytes,
      earlyBytes,
      openMs: openedAt === null ? null : openedAt - since,
      stopMs: stopAt === null ? null : stopAt - since,
      endMs: Date.now() - since,
    });
    reportUsage(outcome);
  };
  const close = (last: VoiceInputServerMessage) => {
    if (closed) return;
    closed = true;
    reply(last);
    ws.close(1000);
    settle(last.type === "error" ? last.reason : last.type);
    // At once, not on the client's side of the close: a client that never
    // answers would hold the provider open for ws's 30 s close timeout.
    stream?.abort();
  };

  // Every listening session is a Rome Cloud session, so each one reports.
  function reportUsage(status: string) {
    if (!listening || !options.usage) return;
    const sessionId = listening.source.romeCloudSessionId;
    const { transcriber } = listening.source;
    options.usage.recordTranscription({
      sessionId,
      provider: transcriber.providerId,
      model: transcriber.model,
      // PCM s16le mono: two bytes a sample. Only what reached the provider.
      seconds: Math.round(((stream?.sentBytes ?? 0) / 2 / listening.sampleRate) * 10) / 10,
      status,
      durationMs: Date.now() - listening.startedAt,
    });
  }

  // Counts one frame, or closes the socket when the client sends audio
  // faster than a microphone records it.
  const accept = (chunk: Uint8Array): boolean => {
    if (!pace) return false;
    const allowed = (pace.sampleRate * 2 * (Date.now() - pace.since + AUDIO_SLACK_MS)) / 1000;
    if (bytes + chunk.byteLength > allowed) {
      close({ type: "error", reason: "bad-request" });
      return false;
    }
    frames += 1;
    bytes += chunk.byteLength;
    return true;
  };

  async function begin(sampleRate: number) {
    starting = true;
    const [opened, terms] = await Promise.all([
      options.source.open(),
      Promise.resolve()
        .then(() => (options.voiceTerms ?? readVoiceTerms)())
        .catch(() => {
          log.warn("could not read voice terms; continuing without terms");
          return [];
        }),
    ]);
    starting = false;
    if (opening) clearTimeout(opening);
    if (closed) return;
    if (!opened.ok) {
      close({ type: "error", reason: opened.reason, detail: opened.detail });
      return;
    }
    const { transcriber } = opened.source;
    openedAt = Date.now();
    listening = { source: opened.source, sampleRate, startedAt: openedAt };
    log.info("voice input started", {
      provider: transcriber.place.provider,
      sessionId: opened.source.romeCloudSessionId,
      sampleRate,
      termCount: terms.length,
    });
    const fillers = createFillerFilter();
    const showLast = () => {
      const last = fillers.finish();
      if (last && !closed) reply({ type: "text", ...last });
    };
    stream = transcriber.open(
      { sampleRate, ...(terms.length ? { terms } : {}) },
      {
        onText: (settled, pending, spokeUntilMs) => {
          if (closed) return;
          // Only new words are speech: a withdrawn guess is not. Without the
          // provider's timing, the words count as heard now.
          if (settled.trim() || (pending.trim() && pending !== lastPending)) {
            spokeUntil = Math.max(spokeUntil, spokeUntilMs ?? audioMs());
            audioArrived();
          }
          lastPending = pending;
          reply({ type: "text", ...fillers.update(settled, pending) });
        },
        onEnd: () => {
          showLast();
          close(stoppedFor ? { type: "error", reason: stoppedFor } : { type: "ended" });
        },
        onFailure: (failure, detail) => {
          log.warn("voice input provider failed", { failure, detail });
          showLast();
          close({ type: "error", reason: STOP_REASON[failure] });
        },
      },
    );
    for (const chunk of early.splice(0)) stream.sendAudio(chunk);
    if (stopAsked) return finish();
    limit = setTimeout(() => stopFor("time-limit"), maxDictationMs);
    audioArrived();
  }

  // Speech is measured on the audio's own clock: listening stops once
  // `quietLimitMs` of audio has passed since the end of the last word heard,
  // however late the provider reports that word. Audio that stops arriving
  // counts as silence too.
  let lastPending = "";
  let spokeUntil = 0;
  const audioMs = () => (listening ? (bytes / 2 / listening.sampleRate) * 1000 : 0);
  function audioArrived() {
    if (finishAsked || !stream) return;
    if (audioMs() - spokeUntil >= quietLimitMs) return stopFor("no-speech");
    if (quiet) clearTimeout(quiet);
    // Audio that stalls now still stops on time: only the rest of the quiet is left.
    quiet = setTimeout(() => stopFor("no-speech"), quietLimitMs - (audioMs() - spokeUntil));
  }

  function stopFor(reason: VoiceInputStopReason) {
    if (finishAsked) return;
    stoppedFor = reason;
    finish();
  }

  const take = (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      if (!starting && !stream) return close({ type: "error", reason: "bad-request" });
      // Audio after a stop is not part of the dictation.
      if (stopAsked || finishAsked) return;
      const chunk = toBytes(data);
      if (!accept(chunk)) return;
      if (starting) {
        early.push(chunk);
        earlyBytes += chunk.byteLength;
      } else {
        stream?.sendAudio(chunk);
        audioArrived();
      }
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
      // Audio recorded while the socket connected counts as if it had come in real time.
      const buffered = Math.min(message.data.bufferedMs ?? 0, MAX_BUFFERED_MS);
      pace = { since: Date.now() - buffered, sampleRate: message.data.sampleRate };
      // Lets the client tell a quiet stream from a dead connection.
      alive = setInterval(() => reply({ type: "alive" }), VOICE_INPUT_ALIVE_INTERVAL_MS);
      void begin(message.data.sampleRate).catch((err: unknown) => {
        log.error("voice input could not start", {
          error: err instanceof Error ? err.message : String(err),
        });
        close({ type: "error", reason: "provider-unavailable" });
      });
      return;
    }
    stopAt ??= Date.now();
    if (starting) {
      // A stop does not wait forever for the source to open.
      stopAsked = true;
      opening ??= setTimeout(
        () => close({ type: "error", reason: "service-unavailable" }),
        openTimeoutMs,
      );
      return;
    }
    if (!stream) return close({ type: "error", reason: "bad-request" });
    finish();
  };
  ws.on("message", (data: RawData, isBinary) => entry.admit(() => take(data, isBinary)));

  // Asks the provider for the rest of the text.
  function finish() {
    if (!stream || finishAsked) return;
    finishAsked = true;
    if (limit) clearTimeout(limit);
    if (quiet) clearTimeout(quiet);
    stream.finish();
    // Gives up on a provider that never sends the rest.
    finishing = setTimeout(() => {
      stream?.abort();
      close({ type: "error", reason: stoppedFor ?? "provider-unavailable" });
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
