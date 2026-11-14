// Rome Cloud's transcription sessions: for each listening session, Rome Cloud
// names the provider and hands over a short-lived credential for it. The audio
// never goes through Rome Cloud. Contract: docs/concepts/rome-cloud.md#voice-input.

const REQUEST_TIMEOUT_MS = 10_000;

/** One listening session's provider, as Rome Cloud granted it. */
export interface RomeCloudTranscriptionSession {
  /** Rome Cloud's id for the session. The usage event for it carries the same id. */
  sessionId: string;
  provider: string;
  url: string;
  model: string;
  /** A credential for the provider, valid for a few minutes. */
  token: string;
}

export type RomeCloudSessionOutcome =
  | { kind: "granted"; session: RomeCloudTranscriptionSession }
  /** Rome Cloud said no. `code` is its reason, such as `voice_input_rate_limited`. */
  | { kind: "refused"; code: string }
  /** Rome Cloud no longer accepts this instance's credential. */
  | { kind: "signed-out" }
  /** Rome Cloud could not be asked, or answered with something unreadable. */
  | { kind: "unavailable"; detail: string };

export interface RomeCloudCaller {
  origin: string;
  /** A bearer for one Rome Cloud request, or null when none is available. */
  bearer: () => Promise<string | null>;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Asks Rome Cloud for one transcription session, as the instance. */
export async function requestRomeCloudSession(
  caller: RomeCloudCaller,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<RomeCloudSessionOutcome> {
  const token = await caller.bearer();
  if (!token) return { kind: "signed-out" };
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/transcription/sessions", caller.origin), {
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
    const code = isText(body?.error) ? body.error : null;
    // The instance credential itself was refused, as every Rome Cloud route does.
    if (response.status === 401 || code === "instance_revoked") return { kind: "signed-out" };
    if (code) return { kind: "refused", code: code.slice(0, 64) };
    return { kind: "unavailable", detail: `status ${response.status}` };
  }
  if (
    !body ||
    !isText(body.sessionId) ||
    !isText(body.provider) ||
    !isText(body.url) ||
    !isText(body.model) ||
    !isText(body.token)
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
      token: body.token,
    },
  };
}
