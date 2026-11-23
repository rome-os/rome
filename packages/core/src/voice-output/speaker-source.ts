// Opens speaking sessions for voice conversation mode. It is the one place
// that decides whether Rome may speak: with the `voice_mode` gate off it makes
// no speaker, asks for no credential and opens no connection. A session lasts
// longer than its credential: it moves to a new one when the provider refuses
// the old.

import { createLogger } from "../logger.js";
import { speakerFor } from "./create-speaker.js";
import type { SpeakerError, SpeakerListener, SpeakerSession } from "./speaker.js";
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
  const retire = deps.credentials.retire?.bind(deps.credentials);
  return {
    async open(listener) {
      if (!(await enabled())) return { ok: false, reason: "disabled" };
      return renewing(listener, (inner) => openOnCredential(deps.credentials, inner), retire);
    },
  };
}

/** Opens one session on one credential from `credentials`. */
async function openOnCredential(
  credentials: SpeechCredentialSource,
  listener: SpeakerListener,
): Promise<SpeakerOpenOutcome> {
  const outcome = await credentials.get();
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
      const granted = outcome.credentials;
      try {
        const speaker = speakerFor(granted.provider, {
          token: granted.token,
          url: granted.url,
          model: granted.model,
          voice: granted.voice,
        });
        if (!speaker) {
          log.warn("speech provider has no adapter", { provider: granted.provider });
          return { ok: false, reason: "unknown-provider", detail: granted.provider };
        }
        const { sessionId } = granted;
        const record = credentials.recordUsage?.bind(credentials);
        return {
          ok: true,
          session:
            sessionId && record
              ? metered(speaker.open.bind(speaker), listener, (usage) => record(sessionId, usage))
              : speaker.open(listener),
          provider: granted.provider,
          credentialSessionId: granted.sessionId,
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
}

/** One session on one credential, within a session that renews its credential. */
interface Leg {
  session: SpeakerSession | null;
  credentialSessionId?: string;
  /** Sentences said on this leg and not over yet. */
  live: Set<string>;
}

/**
 * Opens a session that outlives its credential. When the provider refuses
 * the credential, as Soniox does for a new stream once a temporary key has
 * expired or been revoked, the session retires the credential, opens a new
 * session on a fresh one, and says again on it each refused sentence none of
 * whose audio came. Sentences already speaking on the old credential finish
 * there. It renews at most once until audio comes again, and says a sentence
 * again at most once, so a credential refused from the start fails as before.
 *
 * Across a renewal, sentences may start out of the order they were said: one
 * whose refusal comes late, or after the new credential is in use, starts
 * after a later one. Audio still names its sentence, and the caller plays
 * sentences in its own order.
 */
async function renewing(
  listener: SpeakerListener,
  openOn: (listener: SpeakerListener) => Promise<SpeakerOpenOutcome>,
  retire: ((sessionId: string) => void) | undefined,
): Promise<SpeakerOpenOutcome> {
  // The text and place in order of each sentence said and not over yet.
  const said = new Map<string, { text: string; order: number }>();
  let order = 0;
  const heard = new Set<string>();
  const retried = new Set<string>();
  // Sentences waiting for the new credential.
  const waiting: string[] = [];
  const legs = new Set<Leg>();
  let current: Leg = { session: null, live: new Set() };
  let renewal: Promise<void> | null = null;
  let mayRenew = true;
  let closed = false;

  const forget = (id: string) => {
    said.delete(id);
    heard.delete(id);
    retried.delete(id);
  };
  const sayOn = (leg: Leg, id: string) => {
    const sentence = said.get(id);
    if (!sentence || !leg.session) return;
    leg.live.add(id);
    leg.session.say(id, sentence.text);
  };
  // A leg the session has moved on from closes once nothing runs on it.
  const tidy = (leg: Leg) => {
    if (leg === current || leg.live.size > 0 || !legs.has(leg)) return;
    legs.delete(leg);
    leg.session?.close();
  };

  // The session is over: every sentence not over yet fails with `error` first.
  const end = (error: SpeakerError) => {
    closed = true;
    const ids = [...waiting.splice(0)];
    for (const leg of legs) {
      ids.push(...leg.live);
      leg.session?.close();
    }
    legs.clear();
    for (const id of ids) {
      forget(id);
      listener.onSentenceError(id, error);
    }
    listener.onClosed(error);
  };

  const renew = (from: Leg, error: SpeakerError) => {
    mayRenew = false;
    if (from.credentialSessionId) retire?.(from.credentialSessionId);
    const next: Leg = { session: null, live: new Set() };
    const opening = openOn(legListener(next)).catch(
      (): SpeakerOpenOutcome => ({ ok: false, reason: "unavailable" }),
    );
    renewal = opening.then((outcome) => {
      renewal = null;
      if (closed) {
        if (outcome.ok) outcome.session.close();
        return;
      }
      const ids = waiting
        .splice(0)
        .sort((a, b) => (said.get(a)?.order ?? 0) - (said.get(b)?.order ?? 0));
      if (!outcome.ok) {
        log.warn("speech credential not renewed", { reason: outcome.reason });
        for (const id of ids) {
          forget(id);
          listener.onSentenceError(id, error);
        }
        if (!legs.has(current)) end(error);
        return;
      }
      log.info("speech credential renewed");
      next.session = outcome.session;
      next.credentialSessionId = outcome.credentialSessionId;
      legs.add(next);
      const old = current;
      current = next;
      for (const id of ids) sayOn(next, id);
      tidy(old);
    });
  };

  function legListener(leg: Leg): SpeakerListener {
    return {
      onAudio(frame) {
        if (closed) return;
        heard.add(frame.sentenceId);
        // Only the newest credential speaking shows that renewing worked.
        if (leg === current && !renewal) mayRenew = true;
        listener.onAudio(frame);
      },
      onSentenceEnd(id) {
        if (closed) return;
        leg.live.delete(id);
        forget(id);
        listener.onSentenceEnd(id);
        tidy(leg);
      },
      onSentenceError(id, error) {
        if (closed) return;
        leg.live.delete(id);
        const again =
          error.kind === "unauthorized" &&
          said.has(id) &&
          !heard.has(id) &&
          !retried.has(id) &&
          (renewal !== null || leg !== current || mayRenew);
        if (again) {
          retried.add(id);
          if (renewal || leg === current) {
            waiting.push(id);
            if (!renewal) renew(leg, error);
          } else sayOn(current, id);
        } else {
          forget(id);
          listener.onSentenceError(id, error);
        }
        tidy(leg);
      },
      onClosed(error) {
        legs.delete(leg);
        if (leg !== current || closed || renewal) return;
        if (error.kind === "unauthorized" && mayRenew) return renew(leg, error);
        end(error);
      },
    };
  }

  const first = await openOn(legListener(current));
  if (!first.ok) return first;
  current.session = first.session;
  current.credentialSessionId = first.credentialSessionId;
  legs.add(current);

  const session: SpeakerSession = {
    get format() {
      return (current.session ?? first.session).format;
    },
    say(sentenceId, text) {
      if (closed) return;
      said.set(sentenceId, { text, order: order++ });
      if (renewal) waiting.push(sentenceId);
      else sayOn(current, sentenceId);
    },
    stop() {
      const stopped = waiting.splice(0);
      for (const leg of legs) {
        const ids = leg.session?.stop() ?? [];
        for (const id of ids) leg.live.delete(id);
        stopped.push(...ids);
      }
      for (const id of stopped) forget(id);
      for (const leg of [...legs]) tidy(leg);
      return stopped;
    },
    close() {
      closed = true;
      for (const leg of legs) leg.session?.close();
      legs.clear();
      waiting.length = 0;
      said.clear();
    },
  };
  return { ...first, session };
}

/**
 * Opens a session that counts the text the provider spoke and the audio it
 * sent back, and hands the count to `record` as each sentence finishes and
 * when the session stops or ends. A sentence's text counts once its first
 * audio arrives, so one stopped before it was spoken does not count.
 */
function metered(
  open: (listener: SpeakerListener) => SpeakerSession,
  listener: SpeakerListener,
  record: (usage: SpeechUsage) => void,
): SpeakerSession {
  // The characters of each sentence said and not yet heard.
  const unheard = new Map<string, number>();
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
      characters += unheard.get(frame.sentenceId) ?? 0;
      unheard.delete(frame.sentenceId);
      audioBytes += frame.pcm.byteLength;
      listener.onAudio(frame);
    },
    onSentenceEnd(sentenceId) {
      unheard.delete(sentenceId);
      flush();
      listener.onSentenceEnd(sentenceId);
    },
    onSentenceError(sentenceId, error) {
      unheard.delete(sentenceId);
      flush();
      listener.onSentenceError(sentenceId, error);
    },
    onClosed(error) {
      unheard.clear();
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
      unheard.set(sentenceId, [...text].length);
      session.say(sentenceId, text);
    },
    stop() {
      const stopped = session.stop();
      for (const sentenceId of stopped) unheard.delete(sentenceId);
      flush();
      return stopped;
    },
    close() {
      session.close();
      unheard.clear();
      flush();
    },
  };
}
