// The speaking port: where text becomes speech. Each provider is one adapter
// file beside this one; `create-speaker.ts` picks it by name. The port knows
// nothing of any provider's protocol, streams or limits.

/** The audio every speaker delivers. */
export interface SpeakerAudioFormat {
  encoding: "pcm_s16le";
  /** Samples per second, mono. */
  sampleRate: number;
}

/** Why a sentence or a session failed, sorted by what the caller can do about it. */
export type SpeakerErrorKind =
  /** The provider has no room for another stream or connection for this account. Wait, or say fewer sentences at once. */
  | "busy"
  /** The credential is missing, wrong, expired or not allowed to speak. A new credential may help. */
  | "unauthorized"
  /** The account's balance or budget with the provider is used up. */
  | "quota-exhausted"
  /** The provider missed a deadline, or stopped answering. */
  | "timeout"
  /** The provider cut the audio at its length limit. What was delivered is a truncated sentence. */
  | "output-too-long"
  /** The provider refused the request itself: a voice, language or text it cannot use. */
  | "invalid-request"
  /** The provider failed, could not be reached, or dropped the connection. */
  | "provider-unavailable";

export class SpeakerError extends Error {
  override readonly name = "SpeakerError";

  constructor(
    readonly kind: SpeakerErrorKind,
    detail: string,
    /** The provider's own stable error id, such as `max_concurrent_streams_reached`, when it gave one. */
    readonly providerCode?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
  }
}

export interface SpeakerAudioFrame {
  /** The id the caller gave to `say`. */
  sentenceId: string;
  /**
   * The provider stream that carried the frame. A stream id is reused after
   * the provider ends the stream, so it only tells frames of one stream apart
   * from those of another running now.
   */
  streamId: string;
  /** Raw PCM, signed 16-bit little-endian, mono, at the session's sample rate. Whole samples only. */
  pcm: Uint8Array;
}

export interface SpeakerListener {
  /** Frames of one sentence arrive in order. Frames of different sentences may interleave. Never called after `stop()` for a stopped sentence. */
  onAudio(frame: SpeakerAudioFrame): void;
  /** The sentence's last frame has been delivered. Called once per sentence, after its last `onAudio`. Not called for a sentence that failed or was stopped. */
  onSentenceEnd(sentenceId: string): void;
  /** The sentence failed. Frames already delivered stay delivered. Other sentences go on. Called once, last for the sentence. */
  onSentenceError(sentenceId: string, error: SpeakerError): void;
  /**
   * The session is over. Called once, last, and never after `close()`: `error`
   * is why, such as a lost connection or a refused credential. Sentences still
   * waiting or running have got `onSentenceError` before this.
   */
  onClosed(error: SpeakerError): void;
}

export interface SpeakerSession {
  readonly format: SpeakerAudioFormat;
  /**
   * Speaks one sentence as its own stream, so its audio starts without
   * waiting for any later text. Sentences start in the order they were said,
   * as the provider has room. A sentence too long for one stream is split and
   * its parts follow one another.
   */
  say(sentenceId: string, text: string): void;
  /**
   * Stops every sentence running or waiting, now. Audio of a stopped sentence
   * that is still on its way is dropped. Returns the ids of the sentences it
   * stopped, who get no end or error event.
   */
  stop(): readonly string[];
  /** Ends the session and drops what is running. The listener hears nothing more. */
  close(): void;
}

export interface Speaker {
  readonly providerId: string;
  /** Opens one speaking session. Sentences said before the provider answers wait and go in order. */
  open(listener: SpeakerListener): SpeakerSession;
}
