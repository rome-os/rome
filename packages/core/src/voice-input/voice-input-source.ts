// Where each listening session's transcriber comes from: a Rome signed in to
// Rome Cloud asks it for a session every time. The instance holds no
// long-lived credential for a transcription provider.

import type { VoiceInputInfo, VoiceInputStopReason } from "@rome/api-types/voice-input";
import { createLogger } from "../logger.js";
import { transcriberFor } from "./create-transcriber.js";
import {
  type RomeCloudCaller,
  type RomeCloudSessionOutcome,
  readRomeCloudProvider,
  requestRomeCloudSession,
} from "./rome-cloud-session.js";
import type { Transcriber, TranscriptionPlace } from "./transcriber.js";

const log = createLogger("voice-input");

/** One listening session's transcriber. */
export interface ListeningSource {
  transcriber: Transcriber;
  /** Rome Cloud's id for the session, which its usage event carries. */
  romeCloudSessionId: string;
}

export type OpenOutcome =
  | { ok: true; source: ListeningSource }
  | { ok: false; reason: VoiceInputStopReason; detail?: string };

export interface VoiceInputSource {
  /** False while not signed in to Rome Cloud; the voice control is then absent. */
  available(): boolean;
  /** What the read API and Settings show. */
  info(): Promise<VoiceInputInfo>;
  /** The transcriber for one listening session. */
  open(): Promise<OpenOutcome>;
}

const NONE: VoiceInputInfo = { available: false, place: null };

/** No source at all: the voice control is absent. */
export const NO_VOICE_INPUT: VoiceInputSource = {
  available: () => false,
  info: async () => NONE,
  open: async () => ({ ok: false, reason: "service-unavailable" }),
};

export interface VoiceInputSourceDeps {
  /** Rome Cloud as the instance reaches it, or null while not signed in. */
  romeCloud: () => RomeCloudCaller | null;
  fetch?: typeof fetch;
}

// How long Rome trusts the provider Rome Cloud named.
const PROVIDER_TTL_MS = 60_000;

// Rome Cloud names providers by their lower-case id.
const PROVIDER_NAMES: Record<string, string> = { soniox: "Soniox" };

export function createVoiceInputSource(deps: VoiceInputSourceDeps): VoiceInputSource {
  // Keyed by the Rome Cloud and credential that named it, so a different
  // account never sees another's answer.
  let named: { place: TranscriptionPlace; at: number; asker: string } | null = null;

  const askRomeCloud = async (caller: RomeCloudCaller) => {
    const outcome: RomeCloudSessionOutcome = await requestRomeCloudSession(caller, deps.fetch);
    if (outcome.kind !== "granted") return outcome;
    const { session } = outcome;
    let transcriber: Transcriber | null;
    try {
      transcriber = transcriberFor(session.provider, {
        apiKey: session.token,
        url: session.url,
        model: session.model,
      });
    } catch (err) {
      return {
        kind: "unavailable" as const,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
    if (!transcriber) return { kind: "unknown-provider" as const, provider: session.provider };
    return { kind: "granted" as const, transcriber, sessionId: session.sessionId };
  };

  // The place Rome Cloud serves from, read without minting a credential.
  const romeCloudInfo = async (caller: RomeCloudCaller): Promise<VoiceInputInfo> => {
    const now = Date.now();
    const asker = `${caller.origin} ${(await caller.bearer()) ?? ""}`;
    if (named && named.asker === asker && now - named.at < PROVIDER_TTL_MS) {
      return { available: true, place: named.place };
    }
    named = null;
    const outcome = await readRomeCloudProvider(caller, deps.fetch);
    switch (outcome.kind) {
      case "named": {
        const { provider, host } = outcome.provider;
        named = {
          place: { provider: PROVIDER_NAMES[provider] ?? provider, host },
          at: now,
          asker,
        };
        return { available: true, place: named.place };
      }
      case "not-configured":
        return {
          available: true,
          place: null,
          placeUnknown: "rome-cloud-not-configured",
        };
      case "unavailable":
        log.warn("rome cloud transcription provider unreadable", { detail: outcome.detail });
        return {
          available: true,
          place: null,
          placeUnknown: "rome-cloud-unreachable",
        };
      case "not-allowed":
        return NONE;
      case "signed-out":
        return { available: true, place: null, placeUnknown: "rome-cloud-signed-out" };
    }
  };

  return {
    available: () => deps.romeCloud() !== null,

    async info() {
      const caller = deps.romeCloud();
      if (!caller) {
        named = null;
        return NONE;
      }
      return romeCloudInfo(caller);
    },

    async open() {
      const caller = deps.romeCloud();
      if (!caller) return { ok: false, reason: "service-unavailable" };
      const outcome = await askRomeCloud(caller);
      // The place named for Rome Cloud may no longer say where audio goes.
      if (outcome.kind !== "granted") named = null;
      switch (outcome.kind) {
        case "granted":
          return {
            ok: true,
            source: { transcriber: outcome.transcriber, romeCloudSessionId: outcome.sessionId },
          };
        case "refused":
          log.warn("rome cloud refused a transcription session", { code: outcome.code });
          return { ok: false, reason: "service-refused", detail: outcome.code };
        case "signed-out":
          return { ok: false, reason: "service-signed-out" };
        case "unavailable":
          log.warn("rome cloud transcription session failed", { detail: outcome.detail });
          return { ok: false, reason: "service-unavailable" };
        case "unknown-provider":
          log.warn("rome cloud named a provider rome has no adapter for", {
            provider: outcome.provider,
          });
          return { ok: false, reason: "service-unavailable" };
      }
    },
  };
}
