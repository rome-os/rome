// Soniox real-time speech adapter, model `tts-rt-v2`.
// Protocol: https://docs.soniox.com/api-reference/tts/websocket-api
//
// One connection carries many streams. Each sentence is its own stream and
// ends with `text_end` in the same breath: Soniox starts speaking at once for
// a closed stream (about 0.2 s to the first audio), but holds a stream that
// is still open until more text arrives, and drops one that gets no text for
// about 5 s.

import WebSocket from "ws";
import {
  type Speaker,
  type SpeakerAudioFormat,
  SpeakerError,
  type SpeakerErrorKind,
  type SpeakerListener,
  type SpeakerSession,
} from "./speaker.js";
import { DEFAULT_SPLIT_LIMITS, type SplitLimits, splitForStreams } from "./split-text.js";

const SONIOX_TTS_DEFAULT_URL = "wss://tts-rt.soniox.com/tts-websocket";
const SONIOX_TTS_DEFAULT_MODEL = "tts-rt-v2";
const SONIOX_TTS_DEFAULT_VOICE = "Iris";
const SONIOX_TTS_DEFAULT_LANGUAGE = "zh";
const SONIOX_TTS_SAMPLE_RATE = 24_000;

/** Streams one connection runs at once. Fixed by Soniox. */
const SONIOX_TTS_MAX_STREAMS_PER_CONNECTION = 5;
/** Soniox closes a connection that has been silent for about 43 s. */
const SONIOX_TTS_KEEP_ALIVE_MS = 25_000;
// How long the provider has to accept the connection.
const SONIOX_TTS_CONNECT_TIMEOUT_MS = 10_000;
// A stream the provider says nothing about for this long is given up. Audio
// comes faster than it plays, so a healthy stream never goes quiet this long.
const SONIOX_TTS_STREAM_STALL_MS = 20_000;
// How long a cancelled or failed stream may take to say `terminated`. Soniox
// answers a cancel in about 0.1 s.
const TERMINATED_GRACE_MS = 2_000;

/** Starts a timer and returns what stops it. Tests drive this with a clock of their own. */
export type Schedule = (ms: number, fn: () => void) => () => void;

const realSchedule: Schedule = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

export interface SonioxSpeakerOptions {
  /** A long-lived or temporary key. It goes in the `Authorization` header and nowhere else. */
  token: string;
  url?: string;
  model?: string;
  voice?: string;
  /** The main language of the text, which sets the prosody. Any voice speaks any language. */
  language?: string;
  sampleRate?: number;
  /** Streams run at once on the connection, at most 5. More sentences wait their turn. */
  maxConcurrentStreams?: number;
  keepAliveMs?: number;
  connectTimeoutMs?: number;
  streamStallMs?: number;
  splitLimits?: SplitLimits;
  schedule?: Schedule;
}

export function createSonioxSpeaker(options: SonioxSpeakerOptions): Speaker {
  return {
    providerId: "soniox",
    open: (listener) => new SonioxSession(options, listener),
  };
}

/** One sentence, in as many parts as the provider's limits need. */
interface Sentence {
  id: string;
  parts: string[];
  /** The part to start next. */
  next: number;
  /** Set when the sentence has ended, failed or been stopped, so nothing is reported twice. */
  over: boolean;
}

interface Stream {
  id: string;
  sentence: Sentence;
  /** The caller stopped the sentence, or the adapter gave up on the stream. Its audio is dropped. */
  dropped: boolean;
  /** An odd byte left at the end of a frame, held for the next one. */
  carry: number | null;
  stop: () => void;
}

class SonioxSession implements SpeakerSession {
  readonly format: SpeakerAudioFormat;

  private readonly ws: WebSocket;
  private readonly url: string;
  private readonly model: string;
  private readonly voice: string;
  private readonly language: string;
  private readonly maxStreams: number;
  private readonly keepAliveMs: number;
  private readonly stallMs: number;
  private readonly splitLimits: SplitLimits;
  private readonly schedule: Schedule;

  private connected = false;
  private closed = false;
  // Why the session ended, when the provider or the network ended it.
  private failure: SpeakerError | null = null;
  // Sentences that have not ended, in the order they were said.
  private live: Sentence[] = [];
  // Those of them that have not started a stream yet.
  private waiting: Sentence[] = [];
  // Streams the provider has not said `terminated` for, and that still hold one of its slots.
  private readonly streams = new Map<string, Stream>();
  // Ids free to use again: each had its `terminated`.
  private readonly freeIds: string[] = [];
  private idCount = 0;
  private stopConnecting: () => void = () => {};
  private stopKeepAlive: () => void = () => {};

  constructor(
    private readonly options: SonioxSpeakerOptions,
    private readonly listener: SpeakerListener,
  ) {
    this.url = options.url ?? SONIOX_TTS_DEFAULT_URL;
    this.model = options.model ?? SONIOX_TTS_DEFAULT_MODEL;
    this.voice = options.voice ?? SONIOX_TTS_DEFAULT_VOICE;
    this.language = options.language ?? SONIOX_TTS_DEFAULT_LANGUAGE;
    this.format = {
      encoding: "pcm_s16le",
      sampleRate: options.sampleRate ?? SONIOX_TTS_SAMPLE_RATE,
    };
    this.maxStreams = Math.max(
      1,
      Math.min(
        options.maxConcurrentStreams ?? SONIOX_TTS_MAX_STREAMS_PER_CONNECTION,
        SONIOX_TTS_MAX_STREAMS_PER_CONNECTION,
      ),
    );
    this.keepAliveMs = options.keepAliveMs ?? SONIOX_TTS_KEEP_ALIVE_MS;
    this.stallMs = options.streamStallMs ?? SONIOX_TTS_STREAM_STALL_MS;
    this.splitLimits = options.splitLimits ?? DEFAULT_SPLIT_LIMITS;
    this.schedule = options.schedule ?? realSchedule;

    // `ws` would take an https address as wss. The credential names a socket.
    const { protocol } = new URL(this.url);
    if (protocol !== "wss:" && protocol !== "ws:")
      throw new Error("speech address is not a websocket");

    // The key goes in the header, as Soniox asks. It refuses the `api_key`
    // field of the config message from January 2027.
    this.ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${options.token}` } });
    this.stopConnecting = this.schedule(
      options.connectTimeoutMs ?? SONIOX_TTS_CONNECT_TIMEOUT_MS,
      () => this.fail(new SpeakerError("provider-unavailable", "connect timed out")),
    );
    this.ws.on("open", () => {
      this.connected = true;
      this.stopConnecting();
      this.pump();
      this.armKeepAlive();
    });
    this.ws.on("message", (data, isBinary) => {
      if (!isBinary) this.receive(data.toString());
    });
    this.ws.on("unexpected-response", (_request, response) => {
      response.resume();
      this.fail(errorFor(response.statusCode ?? 0, undefined, `HTTP ${response.statusCode ?? 0}`));
    });
    this.ws.on("error", (error) =>
      this.fail(new SpeakerError("provider-unavailable", this.redact(error.message))),
    );
    this.ws.on("close", (code, reason) =>
      this.fail(
        new SpeakerError(
          "provider-unavailable",
          this.redact(`connection closed ${code} ${reason.toString()}`.trim()),
        ),
      ),
    );
  }

  say(sentenceId: string, text: string): void {
    if (this.closed) {
      // A caller that has not yet seen `onClosed` still learns its sentence is lost.
      const { failure } = this;
      if (failure) queueMicrotask(() => this.listener.onSentenceError(sentenceId, failure));
      return;
    }
    const sentence: Sentence = {
      id: sentenceId,
      parts: splitForStreams(text, this.splitLimits),
      next: 0,
      over: false,
    };
    this.live.push(sentence);
    this.waiting.push(sentence);
    this.pump();
  }

  stop(): readonly string[] {
    const stopped = this.live.map((sentence) => sentence.id);
    for (const sentence of this.live) sentence.over = true;
    this.live = [];
    this.waiting = [];
    for (const stream of this.streams.values()) this.drop(stream, true);
    return stopped;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.shutDown();
  }

  // --- starting streams ---

  private pump(): void {
    while (this.connected && !this.closed && this.streams.size < this.maxStreams) {
      const sentence = this.waiting.shift();
      if (!sentence) break;
      if (sentence.parts.length === 0) {
        this.end(sentence);
        continue;
      }
      this.start(sentence);
    }
  }

  private start(sentence: Sentence): void {
    const id = this.freeIds.shift() ?? `s${++this.idCount}`;
    const text = sentence.parts[sentence.next++] as string;
    const stream: Stream = { id, sentence, dropped: false, carry: null, stop: () => {} };
    this.streams.set(id, stream);
    this.stopKeepAlive();
    this.watch(stream);
    this.send({
      stream_id: id,
      model: this.model,
      language: this.language,
      voice: this.voice,
      audio_format: "pcm_s16le",
      sample_rate: this.format.sampleRate,
    });
    // The whole part and its end in one message: the provider speaks at once.
    this.send({ stream_id: id, text, text_end: true });
  }

  // --- what the provider says ---

  private receive(raw: string): void {
    const message = readMessage(raw);
    if (!message || this.closed) return;
    if (message.error_code !== undefined || message.error_type !== undefined) {
      const error = errorFor(
        message.error_code ?? 0,
        message.error_type,
        this.redact(message.error_message ?? ""),
      );
      if (message.stream_id === undefined) this.fail(error);
      else this.streamFailed(message.stream_id, error);
      return;
    }
    const stream =
      message.stream_id === undefined ? undefined : this.streams.get(message.stream_id);
    if (!stream) return;
    if (message.terminated) {
      this.terminated(stream);
      return;
    }
    // Anything the stream says shows it is alive.
    if (!stream.dropped) this.watch(stream);
    if (message.audio && !stream.dropped) this.audio(stream, message.audio);
  }

  private audio(stream: Stream, base64: string): void {
    let pcm = Buffer.from(base64, "base64");
    if (stream.carry !== null) {
      pcm = Buffer.concat([Buffer.of(stream.carry), pcm]);
      stream.carry = null;
    }
    // A frame holds whole samples; a stray byte goes with the next frame.
    if (pcm.length % 2 === 1) {
      stream.carry = pcm[pcm.length - 1] as number;
      pcm = pcm.subarray(0, pcm.length - 1);
    }
    if (pcm.length === 0) return;
    this.listener.onAudio({ sentenceId: stream.sentence.id, streamId: stream.id, pcm });
  }

  private streamFailed(streamId: string, error: SpeakerError): void {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    // The provider follows a stream's error with `terminated`; the stream
    // keeps its slot until then.
    this.drop(stream, false);
    this.failSentence(stream.sentence, error);
  }

  private terminated(stream: Stream): void {
    this.release(stream, true);
    const { sentence } = stream;
    if (!stream.dropped && !sentence.over) {
      if (sentence.next < sentence.parts.length) this.start(sentence);
      else this.end(sentence);
    }
    this.pump();
    this.armKeepAlive();
  }

  // --- ending sentences ---

  private end(sentence: Sentence): void {
    if (sentence.over) return;
    sentence.over = true;
    this.live = this.live.filter((s) => s !== sentence);
    this.listener.onSentenceEnd(sentence.id);
  }

  private failSentence(sentence: Sentence, error: SpeakerError): void {
    if (sentence.over) return;
    sentence.over = true;
    this.live = this.live.filter((s) => s !== sentence);
    this.waiting = this.waiting.filter((s) => s !== sentence);
    this.listener.onSentenceError(sentence.id, error);
  }

  // --- stopping streams ---

  /** Drops what the stream says from now on. With `cancel`, also tells the provider to stop it. */
  private drop(stream: Stream, cancel: boolean): void {
    if (stream.dropped) return;
    stream.dropped = true;
    if (cancel) this.send({ stream_id: stream.id, cancel: true });
    // A provider that never says `terminated` must not hold the slot for ever.
    stream.stop();
    stream.stop = this.schedule(TERMINATED_GRACE_MS, () => this.release(stream, false));
  }

  /** The stream gives up its slot. Its id goes back in use only if the provider ended it. */
  private release(stream: Stream, ended: boolean): void {
    if (this.streams.get(stream.id) !== stream) return;
    stream.stop();
    this.streams.delete(stream.id);
    if (ended) this.freeIds.push(stream.id);
    if (!ended) {
      this.pump();
      this.armKeepAlive();
    }
  }

  /** Gives up on a stream that has gone quiet. */
  private watch(stream: Stream): void {
    stream.stop();
    stream.stop = this.schedule(this.stallMs, () => {
      this.drop(stream, true);
      this.failSentence(
        stream.sentence,
        new SpeakerError("timeout", `no answer from the provider for ${this.stallMs / 1000} s`),
      );
    });
  }

  // --- connection ---

  private send(message: object): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private armKeepAlive(): void {
    this.stopKeepAlive();
    if (!this.connected || this.closed || this.streams.size > 0) return;
    this.stopKeepAlive = this.schedule(this.keepAliveMs, () => {
      this.send({ keep_alive: true });
      this.armKeepAlive();
    });
  }

  /** The session is over because of `error`: every sentence still open fails with it. */
  private fail(error: SpeakerError): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = error;
    const sentences = this.live;
    this.live = [];
    this.waiting = [];
    this.shutDown();
    for (const sentence of sentences) {
      if (sentence.over) continue;
      sentence.over = true;
      this.listener.onSentenceError(sentence.id, error);
    }
    this.listener.onClosed(error);
  }

  private shutDown(): void {
    this.stopConnecting();
    this.stopKeepAlive();
    for (const stream of this.streams.values()) stream.stop();
    this.streams.clear();
    this.ws.removeAllListeners();
    this.ws.on("error", () => {});
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
      this.ws.terminate();
  }

  /** Keeps the key out of anything that is logged or shown. */
  private redact(text: string): string {
    const { token } = this.options;
    const clean = token ? text.split(token).join("[redacted]") : text;
    return clean.slice(0, 300);
  }
}

// --- reading the provider's messages ---

interface SonioxMessage {
  stream_id?: string;
  audio?: string;
  audio_end?: boolean;
  terminated?: boolean;
  error_code?: number;
  error_type?: string;
  error_message?: string;
}

// A message is read field by field before any of it is used: a malformed one
// is skipped rather than thrown out of the socket's handler.
function readMessage(raw: string): SonioxMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const message: SonioxMessage = {};
  if (typeof input.stream_id === "string") message.stream_id = input.stream_id;
  if (typeof input.audio === "string") message.audio = input.audio;
  if (input.audio_end === true) message.audio_end = true;
  if (input.terminated === true) message.terminated = true;
  if (typeof input.error_code === "number") message.error_code = input.error_code;
  if (typeof input.error_type === "string") message.error_type = input.error_type;
  if (typeof input.error_message === "string") message.error_message = input.error_message;
  return message;
}

// The provider's own ids for a full account or connection. Soniox sends the
// stream cap as 400, so the id is read before the status.
const BUSY_TYPES = new Set([
  "max_concurrent_streams_reached",
  "max_concurrent_connections_reached",
  "limit_exceeded",
]);

export function kindFor(status: number, type: string | undefined): SpeakerErrorKind {
  if ((type && BUSY_TYPES.has(type)) || status === 429) return "busy";
  if (status === 402) return "quota-exhausted";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 408) return "timeout";
  if (status === 413) return "output-too-long";
  if (status >= 400 && status < 500) return "invalid-request";
  return "provider-unavailable";
}

function errorFor(status: number, type: string | undefined, message: string): SpeakerError {
  const detail = [status ? String(status) : "", type ?? "", message].filter(Boolean).join(" ");
  return new SpeakerError(kindFor(status, type), detail, type);
}
