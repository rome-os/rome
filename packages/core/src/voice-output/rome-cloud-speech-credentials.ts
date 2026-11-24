// Speech credentials from Rome Cloud. An account holds at most five unexpired
// speech sessions, and Rome Cloud cannot end one early, so one session's key
// serves every conversation until shortly before it expires, or until the
// provider refuses it, also across restarts: the session is kept in settings. What Rome speaks on a session is
// added up as it goes and reported once, after the session has expired.
// `speaker-source.ts` is the only caller and asks only when a conversation
// starts. Contract: docs/concepts/rome-cloud.md#voice-conversation.

import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import type { SpeechUsageSink } from "../usage/recorder.js";
import { credentialFingerprint } from "../usage/reporter.js";
import type { RomeCloudCaller } from "../voice-input/rome-cloud-session.js";
import { requestRomeCloudSpeechSession } from "./rome-cloud-speech-session.js";
import type {
  SpeechCredentialOutcome,
  SpeechCredentialSource,
  SpeechUsage,
} from "./speech-credentials.js";

const log = createLogger("voice-output");

/** The settings key that keeps the speech sessions not yet reported. Never shown or written by `/api/settings`. */
export const SPEECH_SESSIONS_SETTING_KEY = "voiceMode.speechSessions";

// A conversation started on a key with less time left than this would lose its
// voice within minutes, so a new session is asked for instead. Only these last
// minutes of one session overlap the next.
const RENEW_BEFORE_EXPIRY_MS = 5 * 60_000;
// A stream opened just before the key expired speaks for up to 5 minutes more,
// and its usage is counted when its sentence ends.
const REPORT_AFTER_EXPIRY_MS = 6 * 60_000;
// How long to wait before reporting again after a report could not be queued,
// or the stored sessions could not be read.
const REPORT_RETRY_MS = 60_000;
// The longest delay setTimeout takes.
const MAX_TIMER_MS = 2 ** 31 - 1;

interface StoredSpeechSession {
  sessionId: string;
  provider: string;
  url: string;
  model: string;
  voice: string;
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** Which Rome Cloud sign-in opened the session, as a fingerprint. */
  asker: string;
  characters: number;
  seconds: number;
}

const isStoredSession = (value: unknown): value is StoredSpeechSession => {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    ["sessionId", "provider", "url", "model", "voice", "token", "asker"].every(
      (key) => typeof s[key] === "string",
    ) && ["expiresAt", "characters", "seconds"].every((key) => Number.isFinite(s[key]))
  );
};

const askerOf = (caller: RomeCloudCaller) =>
  credentialFingerprint(`${caller.origin} ${caller.credentialId}`);

const grant = (session: StoredSpeechSession): SpeechCredentialOutcome => ({
  kind: "granted",
  credentials: {
    provider: session.provider,
    url: session.url,
    model: session.model,
    voice: session.voice,
    token: session.token,
    sessionId: session.sessionId,
  },
});

export interface RomeCloudSpeechCredentialsDeps {
  /** Rome Cloud as the instance reaches it, or null while not signed in. */
  romeCloud: () => RomeCloudCaller | null;
  settings: Pick<SettingsRepository, "get" | "set">;
  usage: SpeechUsageSink | null;
  fetch?: typeof fetch;
  /** Epoch milliseconds. */
  now?: () => number;
}

export interface RomeCloudSpeechCredentials extends SpeechCredentialSource {
  recordUsage(sessionId: string, usage: SpeechUsage): void;
  retire(sessionId: string): void;
  /** Reports every session whose time has come, such as those an earlier run left. */
  report(): Promise<void>;
  /** Stops the timer that reports the next session. */
  stop(): void;
}

export function createRomeCloudSpeechCredentials(
  deps: RomeCloudSpeechCredentialsDeps,
): RomeCloudSpeechCredentials {
  const now = deps.now ?? Date.now;
  let sessions: StoredSpeechSession[] | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // No report is tried before this, after one could not be queued.
  let retryAt = 0;
  let queue: Promise<unknown> = Promise.resolve();

  // One change at a time, so a usage count and a new session never overwrite each other.
  const serially = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  // Reports again after a while, while the sessions cannot be read.
  const retryLater = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void source.report(), REPORT_RETRY_MS);
    timer.unref?.();
  };

  const schedule = (list: StoredSpeechSession[]) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (list.length === 0) return;
    const next = Math.max(
      retryAt,
      Math.min(...list.map((s) => s.expiresAt + REPORT_AFTER_EXPIRY_MS)),
    );
    timer = setTimeout(
      () => void source.report(),
      Math.min(MAX_TIMER_MS, Math.max(0, next - now())),
    );
    timer.unref?.();
  };

  // The stored sessions, or null when they cannot be read now. A failed read
  // is not kept: saving over sessions that were never read would lose their
  // keys and unreported usage, so the next call reads again.
  const load = async (): Promise<StoredSpeechSession[] | null> => {
    if (sessions) return sessions;
    let stored: unknown;
    try {
      stored = await deps.settings.get<unknown>(SPEECH_SESSIONS_SETTING_KEY);
    } catch {
      // A database error can quote the stored value, keys and all, so its
      // message is never logged.
      log.warn("speech sessions unreadable");
      return null;
    }
    sessions = Array.isArray(stored) ? stored.filter(isStoredSession) : [];
    schedule(sessions);
    return sessions;
  };

  const save = async (list: StoredSpeechSession[]) => {
    sessions = list;
    schedule(list);
    try {
      await deps.settings.set(SPEECH_SESSIONS_SETTING_KEY, list);
    } catch {
      // Kept in memory still. A restart then asks for a new session. A
      // database error can quote the value written, keys and all, so its
      // message is never logged.
      log.warn("speech sessions not saved");
    }
  };

  // Reports each session whose time has come, once, and returns the rest. A
  // session whose report could not be queued stays, to be tried again, as do
  // all of them while signed out. A session another sign-in opened is
  // dropped: Rome Cloud would not know it.
  const reportDue = async (list: StoredSpeechSession[]): Promise<StoredSpeechSession[]> => {
    const at = now();
    if (at < retryAt) return list;
    const due = list.filter((s) => at >= s.expiresAt + REPORT_AFTER_EXPIRY_MS);
    if (due.length === 0) return list;
    const caller = deps.romeCloud();
    if (!caller) {
      retryAt = at + REPORT_RETRY_MS;
      return list;
    }
    const asker = askerOf(caller);
    const done = new Set<StoredSpeechSession>();
    for (const session of due) {
      if (session.asker === asker && deps.usage) {
        try {
          await deps.usage.recordSpeech({
            sessionId: session.sessionId,
            provider: session.provider,
            model: session.model,
            characters: Math.round(session.characters),
            seconds: Math.round(session.seconds * 10) / 10,
          });
        } catch {
          // The recorder logged why.
          continue;
        }
      }
      done.add(session);
    }
    retryAt = done.size < due.length ? at + REPORT_RETRY_MS : 0;
    return list.filter((s) => !done.has(s));
  };

  const source: RomeCloudSpeechCredentials = {
    get: () =>
      serially(async () => {
        const caller = deps.romeCloud();
        if (!caller) return { kind: "signed-out" };
        const loaded = await load();
        if (!loaded) return { kind: "unavailable", detail: "speech sessions unreadable" };
        const list = await reportDue(loaded);
        if (list !== loaded) await save(list);
        else schedule(list);
        const asker = askerOf(caller);
        const at = now();
        const usable = list
          .filter((s) => s.asker === asker && s.expiresAt - at > RENEW_BEFORE_EXPIRY_MS)
          .sort((a, b) => b.expiresAt - a.expiresAt)[0];
        if (usable) return grant(usable);

        const outcome = await requestRomeCloudSpeechSession(caller, deps.fetch);
        if (outcome.kind !== "granted") return outcome;
        const session = { ...outcome.session, asker, characters: 0, seconds: 0 };
        await save([...list, session]);
        return grant(session);
      }),

    recordUsage(sessionId, usage) {
      const characters = Number.isFinite(usage.characters) ? Math.max(0, usage.characters) : 0;
      const seconds = Number.isFinite(usage.seconds) ? Math.max(0, usage.seconds) : 0;
      if (characters === 0 && seconds === 0) return;
      void serially(async () => {
        const list = await load();
        const session = list?.find((s) => s.sessionId === sessionId);
        if (!list || !session) {
          log.warn("speech usage for a session already reported", { sessionId });
          return;
        }
        session.characters += characters;
        session.seconds += seconds;
        await save(list);
      }).catch(() => {});
    },

    // The session ends now, as far as Rome is concerned: `get` asks for a new
    // one, and the usage is reported once no stream on it can still be speaking.
    retire(sessionId) {
      void serially(async () => {
        const list = await load();
        const session = list?.find((s) => s.sessionId === sessionId);
        if (!list || !session || session.expiresAt <= now()) return;
        log.info("speech session retired", { sessionId });
        session.expiresAt = now();
        await save(list);
      }).catch(() => {});
    },

    report: () =>
      serially(async () => {
        const loaded = await load();
        if (!loaded) {
          retryLater();
          return;
        }
        const list = await reportDue(loaded);
        if (list !== loaded) await save(list);
        else schedule(list);
      }),

    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return source;
}
