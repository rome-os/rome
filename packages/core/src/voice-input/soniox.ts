// Soniox real-time adapter. Protocol: https://docs.soniox.com/stt/api-reference/websocket-api

import WebSocket from "ws";
import type { Transcriber, TranscriptionListener, TranscriptionStream } from "./transcriber.js";

export const SONIOX_DEFAULT_URL = "wss://stt-rt.soniox.com/transcribe-websocket";
export const SONIOX_DEFAULT_MODEL = "stt-rt-v6";

interface SonioxToken {
  text: string;
  is_final: boolean;
}

interface SonioxResponse {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

// Control tokens such as `<end>` and `<fin>` mark endpoints, not speech.
const CONTROL_TOKEN = /^<[a-z]+>$/;

export function createSonioxTranscriber(options: {
  apiKey: string;
  url?: string;
  model?: string;
}): Transcriber {
  const url = options.url ?? SONIOX_DEFAULT_URL;
  const model = options.model ?? SONIOX_DEFAULT_MODEL;
  return {
    place: { provider: "Soniox", host: new URL(url).host },
    model,
    open: ({ sampleRate }, listener) =>
      openSonioxStream(url, options.apiKey, model, sampleRate, listener),
  };
}

function openSonioxStream(
  url: string,
  apiKey: string,
  model: string,
  sampleRate: number,
  listener: TranscriptionListener,
): TranscriptionStream {
  // A long-lived key and a temporary one both go in the header. Soniox
  // refuses the old `api_key` field of the start request from January 2027.
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  // Audio and the end frame wait here until the start request is out.
  const queued: (Uint8Array | string)[] = [];
  let done = false;
  let finishing = false;

  const stop = (outcome: () => void) => {
    if (done) return;
    done = true;
    outcome();
    ws.removeAllListeners();
    ws.on("error", () => {});
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.terminate();
  };

  const send = (frame: Uint8Array | string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    else queued.push(frame);
  };

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        model,
        audio_format: "pcm_s16le",
        sample_rate: sampleRate,
        num_channels: 1,
        language_hints: ["en", "zh"],
      }),
    );
    for (const frame of queued.splice(0)) ws.send(frame);
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary || done) return;
    let response: SonioxResponse;
    try {
      response = JSON.parse(data.toString()) as SonioxResponse;
    } catch {
      return;
    }
    if (response.error_code !== undefined) {
      const refused =
        response.error_code === 400 || response.error_code === 401 || response.error_code === 403;
      stop(() =>
        listener.onFailure(
          refused ? "refused" : "unavailable",
          `${response.error_code} ${response.error_message ?? ""}`.trim(),
        ),
      );
      return;
    }
    let settled = "";
    let pending = "";
    for (const token of response.tokens ?? []) {
      if (CONTROL_TOKEN.test(token.text)) continue;
      if (token.is_final) settled += token.text;
      else pending += token.text;
    }
    if (settled || pending || (response.tokens?.length ?? 0) > 0) listener.onText(settled, pending);
    if (response.finished) stop(() => listener.onEnd());
  });

  ws.on("unexpected-response", (_req, res) => {
    const status = res.statusCode ?? 0;
    stop(() =>
      listener.onFailure(
        status === 401 || status === 403 ? "refused" : "unavailable",
        `HTTP ${status}`,
      ),
    );
  });
  ws.on("error", (error) => stop(() => listener.onFailure("unavailable", error.message)));
  ws.on("close", (code) =>
    stop(() =>
      listener.onFailure(
        "unavailable",
        finishing ? `closed ${code} before finishing` : `closed ${code}`,
      ),
    ),
  );

  return {
    sendAudio(chunk) {
      if (done || finishing || chunk.byteLength === 0) return;
      send(chunk);
    },
    finish() {
      if (done || finishing) return;
      finishing = true;
      // An empty text frame ends the stream; an empty binary frame does not.
      send("");
    },
    abort() {
      stop(() => {});
    },
  };
}
