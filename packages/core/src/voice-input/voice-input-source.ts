// Where each listening session's transcriber comes from. A Rome signed in to
// Rome Cloud asks it for a session every time; one that is not uses its own
// `ROME_TRANSCRIPTION_*` provider.

import type { VoiceInputInfo, VoiceInputStopReason } from "@rome/api-types/voice-input";
import { createLogger } from "../logger.js";
import { transcriberFor } from "./create-transcriber.js";
import {
  type RomeCloudCaller,
  type RomeCloudSessionOutcome,
  requestRomeCloudSession,
} from "./rome-cloud-session.js";
import type { Transcriber, TranscriptionPlace } from "./transcriber.js";

const log = createLogger("voice-input");

/** One listening session's transcriber. */
export interface ListeningSource {
  transcriber: Transcriber;
  /** Rome Cloud's session id, or null on the instance's own provider. */
  romeCloudSessionId: string | null;
}

export type OpenOutcome =
  | { ok: true; source: ListeningSource }
  | { ok: false; reason: VoiceInputStopReason; detail?: string };

export interface VoiceInputSource {
  /** False when there is no source at all; the voice control is then absent. */
  available(): boolean;
  /** What the read API and Settings show. */
  info(): Promise<VoiceInputInfo>;
  /** The transcriber for one listening session. */
  open(): Promise<OpenOutcome>;
}

/** No source at all: the voice control is absent. */
export const NO_VOICE_INPUT: VoiceInputSource = {
  available: () => false,
  info: async () => ({ available: false, via: null, place: null }),
  open: async () => ({ ok: false, reason: "service-unavailable" }),
};

export interface VoiceInputSourceDeps {
  /** The instance's own provider, or null. */
  own: Transcriber | null;
  /** Rome Cloud as the instance reaches it, or null while not signed in. */
  romeCloud: () => RomeCloudCaller | null;
  fetch?: typeof fetch;
}

export function createVoiceInputSource(deps: VoiceInputSourceDeps): VoiceInputSource {
  // The place Rome Cloud named for the last listening session. Settings shows
  // it; asking for a session only to name the place would waste a credential
  // and count against the account's session limit.
  let lastCloudPlace: TranscriptionPlace | null = null;

  const askRomeCloud = async (caller: RomeCloudCaller) => {
    const outcome: RomeCloudSessionOutcome = await requestRomeCloudSession(caller, deps.fetch);
    if (outcome.kind !== "granted") return outcome;
    const { session } = outcome;
    const transcriber = transcriberFor(session.provider, {
      apiKey: session.token,
      url: session.url,
      model: session.model,
    });
    if (!transcriber) return { kind: "unknown-provider" as const, provider: session.provider };
    lastCloudPlace = transcriber.place;
    return { kind: "granted" as const, transcriber, sessionId: session.sessionId };
  };

  return {
    available: () => deps.romeCloud() !== null || deps.own !== null,

    async info() {
      const caller = deps.romeCloud();
      if (caller) return { available: true, via: "rome-cloud", place: lastCloudPlace };
      if (deps.own) return { available: true, via: "instance", place: deps.own.place };
      return { available: false, via: null, place: null };
    },

    async open() {
      const caller = deps.romeCloud();
      if (caller) {
        const outcome = await askRomeCloud(caller);
        switch (outcome.kind) {
          case "granted":
            return {
              ok: true,
              source: { transcriber: outcome.transcriber, romeCloudSessionId: outcome.sessionId },
            };
          case "refused":
            log.warn("rome cloud refused a transcription session", { code: outcome.code });
            return { ok: false, reason: "service-refused", detail: outcome.code };
          case "unavailable":
            log.warn("rome cloud transcription session failed", { detail: outcome.detail });
            return { ok: false, reason: "service-unavailable" };
          case "unknown-provider":
            log.warn("rome cloud named a provider rome has no adapter for", {
              provider: outcome.provider,
            });
            return { ok: false, reason: "service-unavailable" };
          case "signed-out":
            // Rome Cloud no longer takes this instance: its own provider, if any.
            break;
        }
      }
      if (deps.own)
        return { ok: true, source: { transcriber: deps.own, romeCloudSessionId: null } };
      return { ok: false, reason: "service-unavailable" };
    },
  };
}
