// Opens speaking sessions for voice conversation mode. It is the one place
// that decides whether Rome may speak: with the `voice_mode` gate off it makes
// no speaker, asks for no credential and opens no connection.

import { createLogger } from "../logger.js";
import { speakerFor } from "./create-speaker.js";
import type { SpeakerListener, SpeakerSession } from "./speaker.js";
import type { SpeechCredentialSource, SpeechUsage } from "./speech-credentials.js";
import { resolveVoiceModeEnabled } from "./voice-mode-gate.js";

const log = createLogger("voice-output");

type SpeakerOpenOutcome =
  | {
      ok: true;
      session: SpeakerSession;
      provider: string;
      /** The credential source's id for the session, when it gave one. */
      credentialSessionId?: string;
    }
  | {
      ok: false;
      reason: /** The `voice_mode` gate is off. */
        | "disabled"
        /** No source of speech credentials is set up. */
        | "not-configured"
        | "refused"
        | "signed-out"
        | "unavailable"
        /** The source named a provider this build has no adapter for. */
        | "unknown-provider";
      detail?: string;
    };

export interface SpeakerSource {
  open(listener: SpeakerListener): Promise<SpeakerOpenOutcome>;
}

export interface SpeakerSourceDeps {
  credentials: SpeechCredentialSource;
  /** Whether voice mode is on. Read on every `open`. Defaults to the `voice_mode` gate. */
  enabled?: () => Promise<boolean>;
}

export function createSpeakerSource(deps: SpeakerSourceDeps): SpeakerSource {
  const enabled = deps.enabled ?? resolveVoiceModeEnabled;
  return {
    async open(listener) {
      if (!(await enabled())) return { ok: false, reason: "disabled" };
      const outcome = await deps.credentials.get();
      switch (outcome.kind) {
        case "not-configured":
          return { ok: false, reason: "not-configured" };
        case "refused":
          log.warn("speech credential refused", { code: outcome.code });
          return { ok: false, reason: "refused", detail: outcome.code };
        case "signed-out":
          return { ok: false, reason: "signed-out" };
        case "unavailable":
          log.warn("speech credential unavailable", { detail: outcome.detail });
          return { ok: false, reason: "unavailable" };
        case "granted": {
          const { credentials } = outcome;
          try {
            const speaker = speakerFor(credentials.provider, {
              token: credentials.token,
              url: credentials.url,
              model: credentials.model,
              voice: credentials.voice,
            });
            if (!speaker) {
              log.warn("speech provider has no adapter", { provider: credentials.provider });
              return { ok: false, reason: "unknown-provider", detail: credentials.provider };
            }
            const { sessionId } = credentials;
            const record = deps.credentials.recordUsage?.bind(deps.credentials);
            return {
              ok: true,
              session:
                sessionId && record
                  ? metered(speaker.open.bind(speaker), listener, (usage) =>
                      record(sessionId, usage),
                    )
                  : speaker.open(listener),
              provider: credentials.provider,
              credentialSessionId: credentials.sessionId,
            };
          } catch (err) {
            // A bad address makes the socket throw as it opens.
            log.warn("speaker could not be opened", {
              error: err instanceof Error ? err.message : String(err),
            });
            return { ok: false, reason: "unavailable" };
          }
        }
      }
    },
  };
}

/**
 * Opens a session that counts the text it sends and the audio it gets back,
 * and hands the count to `record` as each sentence finishes and when the
 * session stops or ends.
 */
function metered(
  open: (listener: SpeakerListener) => SpeakerSession,
  listener: SpeakerListener,
  record: (usage: SpeechUsage) => void,
): SpeakerSession {
  let characters = 0;
  let audioBytes = 0;
  const flush = () => {
    if (characters === 0 && audioBytes === 0) return;
    // PCM s16le mono: two bytes a sample.
    record({ characters, seconds: audioBytes / 2 / session.format.sampleRate });
    characters = 0;
    audioBytes = 0;
  };
  const session = open({
    onAudio(frame) {
      audioBytes += frame.pcm.byteLength;
      listener.onAudio(frame);
    },
    onSentenceEnd(sentenceId) {
      flush();
      listener.onSentenceEnd(sentenceId);
    },
    onSentenceError(sentenceId, error) {
      flush();
      listener.onSentenceError(sentenceId, error);
    },
    onClosed(error) {
      flush();
      listener.onClosed(error);
    },
  });
  return {
    get format() {
      return session.format;
    },
    say(sentenceId, text) {
      // Code points, so a character outside the BMP counts once.
      characters += [...text].length;
      session.say(sentenceId, text);
    },
    stop() {
      const stopped = session.stop();
      flush();
      return stopped;
    },
    close() {
      session.close();
      flush();
    },
  };
}
