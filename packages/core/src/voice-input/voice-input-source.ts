// Where each listening session's transcriber comes from. A Rome signed in to
// Rome Cloud asks it for a session every time; one that is not uses its own
// `ROME_TRANSCRIPTION_*` provider.

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

// How long Rome trusts the provider Rome Cloud named.
const PROVIDER_TTL_MS = 60_000;

// Rome Cloud refusals that the instance's own provider, if any, answers instead.
const OWN_PROVIDER_SERVES = new Set(["voice_input_not_allowed", "voice_input_not_configured"]);

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
  const romeCloudInfo = async (caller: RomeCloudCaller): Promise<VoiceInputInfo | null> => {
    const now = Date.now();
    const asker = `${caller.origin} ${(await caller.bearer()) ?? ""}`;
    if (named && named.asker === asker && now - named.at < PROVIDER_TTL_MS) {
      return { available: true, via: "rome-cloud", place: named.place };
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
        return { available: true, via: "rome-cloud", place: named.place };
      }
      case "not-configured":
        return {
          available: true,
          via: "rome-cloud",
          place: null,
          placeUnknown: "rome-cloud-not-configured",
        };
      case "unavailable":
        log.warn("rome cloud transcription provider unreadable", { detail: outcome.detail });
        return {
          available: true,
          via: "rome-cloud",
          place: null,
          placeUnknown: "rome-cloud-unreachable",
        };
      case "not-allowed":
        return { available: false, via: null, place: null };
      case "signed-out":
        return null;
    }
  };

  return {
    available: () => deps.romeCloud() !== null || deps.own !== null,

    async info() {
      const caller = deps.romeCloud();
      if (!caller) named = null;
      const cloud = caller ? await romeCloudInfo(caller) : null;
      // The gate lives in Rome Cloud: the instance's own provider is not gated,
      // and serves where Rome Cloud has no provider set up.
      const cloudServes =
        cloud?.available && !(deps.own && cloud.placeUnknown === "rome-cloud-not-configured");
      if (cloud && (cloudServes || !deps.own)) return cloud;
      if (deps.own) return { available: true, via: "instance", place: deps.own.place };
      // Signed in, but Rome Cloud does not take this instance's credential.
      if (caller) {
        return {
          available: true,
          via: "rome-cloud",
          place: null,
          placeUnknown: "rome-cloud-signed-out",
        };
      }
      return { available: false, via: null, place: null };
    },

    async open() {
      const caller = deps.romeCloud();
      if (caller) {
        const outcome = await askRomeCloud(caller);
        // The place named for Rome Cloud no longer says where this session's
        // audio goes.
        if (outcome.kind !== "granted") named = null;
        switch (outcome.kind) {
          case "granted":
            return {
              ok: true,
              source: { transcriber: outcome.transcriber, romeCloudSessionId: outcome.sessionId },
            };
          case "refused":
            // An account Rome Cloud does not allow, or a Rome Cloud with no
            // provider set up, still has the instance's own provider.
            if (OWN_PROVIDER_SERVES.has(outcome.code) && deps.own) break;
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
            // Rome Cloud does not take this instance: its own provider, if any.
            break;
        }
      }
      if (deps.own)
        return { ok: true, source: { transcriber: deps.own, romeCloudSessionId: null } };
      return { ok: false, reason: caller ? "service-signed-out" : "service-unavailable" };
    },
  };
}
