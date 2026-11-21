// Where each speaking session's credential comes from. The port keeps the
// speaker free of how the credential was got: a later source asks Rome Cloud
// for a short-lived speech key, as `voice-input/rome-cloud-session.ts` does for
// listening. Until one exists, `NO_SPEECH_CREDENTIALS` says so plainly.

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

export interface SpeechCredentialSource {
  /** One credential for one speaking session. */
  get(): Promise<SpeechCredentialOutcome>;
}

/** No source at all: speaking is not set up on this instance. */
export const NO_SPEECH_CREDENTIALS: SpeechCredentialSource = {
  get: async () => ({ kind: "not-configured" }),
};
