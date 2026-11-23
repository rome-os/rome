// Rome Cloud's speech sessions: Rome Cloud names the speech provider and hands
// over a short-lived credential for it, as it does for listening in
// `voice-input/rome-cloud-session.ts`. The text and audio never go through
// Rome Cloud. Contract: docs/concepts/rome-cloud.md#voice-conversation.

import type { RomeCloudCaller } from "../voice-input/rome-cloud-session.js";

const REQUEST_TIMEOUT_MS = 10_000;

/** One speech session's provider, as Rome Cloud granted it. */
interface RomeCloudSpeechSession {
  /** Rome Cloud's id for the session. The usage event for it carries the same id. */
  sessionId: string;
  provider: string;
  url: string;
  model: string;
  voice: string;
  /** A credential for the provider that opens new streams until `expiresAt`. */
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export type RomeCloudSpeechSessionOutcome =
  | { kind: "granted"; session: RomeCloudSpeechSession }
  /** Rome Cloud has no speech provider set up. */
  | { kind: "not-configured" }
  /** Rome Cloud said no. `code` is its reason, such as `speech_rate_limited`. */
  | { kind: "refused"; code: string }
  /** Rome Cloud no longer accepts this instance's credential. */
  | { kind: "signed-out" }
  /** Rome Cloud could not be asked, or answered with something unreadable. */
  | { kind: "unavailable"; detail: string };

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

const isStreamUrl = (value: unknown): value is string => {
  if (!isText(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "wss:" || protocol === "ws:";
  } catch {
    return false;
  }
};

// Refusals that say the provider or Rome Cloud failed for now, not that this
// account may not speak. Asking again later may work.
const PASSING_FAILURES = new Set(["provider_unavailable", "speech_unavailable"]);

/** Asks Rome Cloud for one speech session, as the instance. */
export async function requestRomeCloudSpeechSession(
  caller: RomeCloudCaller,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RomeCloudSpeechSessionOutcome> {
  const token = await caller.bearer();
  // Signed in, but no bearer for now: a passing gap, not a lost sign-in.
  if (!token) return { kind: "unavailable", detail: "no bearer" };
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/speech/sessions", caller.origin), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: "unavailable", detail: err instanceof Error ? err.message : String(err) };
  }
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const code = isText(body?.error) ? body.error.slice(0, 64) : null;
    // The instance credential itself was refused, as every Rome Cloud route does.
    if (response.status === 401 || code === "instance_revoked") return { kind: "signed-out" };
    if (code === "speech_not_configured") return { kind: "not-configured" };
    if (code && !PASSING_FAILURES.has(code)) return { kind: "refused", code };
    return { kind: "unavailable", detail: code ?? `status ${response.status}` };
  }
  const expiresAt = isText(body?.expiresAt) ? Date.parse(body.expiresAt) : Number.NaN;
  if (
    !body ||
    !isText(body.sessionId) ||
    !isText(body.provider) ||
    !isStreamUrl(body.url) ||
    !isText(body.model) ||
    !isText(body.voice) ||
    !isText(body.token) ||
    !Number.isFinite(expiresAt)
  ) {
    return { kind: "unavailable", detail: "malformed session" };
  }
  return {
    kind: "granted",
    session: {
      sessionId: body.sessionId,
      provider: body.provider,
      url: body.url,
      model: body.model,
      voice: body.voice,
      token: body.token,
      expiresAt,
    },
  };
}
