// The transcription port: where speech becomes text. Each provider is one
// adapter file beside this one; `create-transcriber.ts` picks it from config.

/** Where speech becomes text, as the guardian sees it. */
export interface TranscriptionPlace {
  provider: string;
  host: string;
}

/** Why a stream stopped before the client finished it. */
export type TranscriptionFailure = "unavailable" | "refused";

export interface TranscriptionListener {
  /**
   * `settled` is text the provider will not change, to append to what came
   * before. `pending` is the whole unsettled tail, which replaces the last one.
   */
  onText(settled: string, pending: string): void;
  /** The provider has sent everything after `finish()`. Called once, last. */
  onEnd(): void;
  /** The stream stopped early. Called once, last, and never after `onEnd`. */
  onFailure(failure: TranscriptionFailure, detail: string): void;
}

export interface TranscriptionStream {
  /** Raw PCM, signed 16-bit little-endian, mono, at the stream's sample rate. Dropped after `finish()` or `abort()`. */
  sendAudio(chunk: Uint8Array): void;
  /** Asks for the rest of the text. The listener then gets `onEnd` or `onFailure`. */
  finish(): void;
  /** Drops the stream. The listener hears nothing more. */
  abort(): void;
}

export interface Transcriber {
  readonly place: TranscriptionPlace;
  /** Opens one stream. Audio sent before the provider answers is held and sent in order. */
  open(options: { sampleRate: number }, listener: TranscriptionListener): TranscriptionStream;
}
