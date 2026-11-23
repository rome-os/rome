// Where each speaking session's credential comes from. The port keeps the
// speaker free of how the credential was got: `rome-cloud-speech-credentials.ts`
// asks Rome Cloud for a short-lived speech key, as
// `voice-input/rome-cloud-session.ts` does for listening. Without a source,
// `NO_SPEECH_CREDENTIALS` says so plainly.

/** What one speaking session needs from its provider. */
interface SpeechCredentials {
  /** The provider's lower-case id, such as `soniox`. */
  provider: string;
  url: string;
  model: string;
  voice: string;
  /** A credential for the provider. Never logged or shown. */
  token: string;
  /** The source's own id for the session, when it has one. Usage reporting can carry it. */
  sessionId?: string;
}

export type SpeechCredentialOutcome =
  | { kind: "granted"; credentials: SpeechCredentials }
  /** Nothing has been set up to give out credentials. */
  | { kind: "not-configured" }
  /** The source said no. `code` is its reason. */
  | { kind: "refused"; code: string }
  | { kind: "signed-out" }
  /** The source could not be asked, or answered with something unreadable. */
  | { kind: "unavailable"; detail: string };

/** What speaking on one credential used. */
export interface SpeechUsage {
  /** Characters of the text the provider spoke: a sentence stopped before any of its audio came does not count. */
  characters: number;
  /** Seconds of audio the provider returned. */
  seconds: number;
}

export interface SpeechCredentialSource {
  /** One credential for one speaking session. */
  get(): Promise<SpeechCredentialOutcome>;
  /** Adds what a speaking session used on the credential with this `sessionId`. Never throws. */
  recordUsage?(sessionId: string, usage: SpeechUsage): void;
  /**
   * The provider refused the credential with this `sessionId`, as it does
   * once the credential expires or is revoked: it is never handed out again.
   * Never throws.
   */
  retire?(sessionId: string): void;
}

/** No source at all: speaking is not set up on this instance. */
export const NO_SPEECH_CREDENTIALS: SpeechCredentialSource = {
  get: async () => ({ kind: "not-configured" }),
};
