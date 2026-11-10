import { cloudBearer } from "../instance/instance-identity.js";
import { getRomeCloudOrigin } from "../instance/rome-cloud-origin.js";

/**
 * The outcome of one attempt to trigger a push via Rome Cloud's `/api/notify`.
 * `NotifyClient` maps every transport/broker condition it can observe to one of
 * these; an unexpected implementation failure (e.g. a dependency throwing) is
 * not mapped and propagates as a throw, per the expected-vs-unexpected split.
 * `outcome_unknown` means delivery may already have happened before the failure
 * surfaced — the caller must not retry without explicit authorization.
 */
export type SendOutcome =
  | { kind: "ok"; attempted: number; sent: number; failed: number }
  | { kind: "no_token" }
  | { kind: "unconfigured" }
  | { kind: "reenroll" }
  /** Rome Cloud refused the named recipient: not the instance's owner nor on its visitor list. Nothing was sent. */
  | { kind: "recipient_not_allowed" }
  /** Rome Cloud pushes only for a hosted instance, and this one is not (desktop, self-hosted, test). Nothing was sent. */
  | { kind: "not_hosted" }
  | { kind: "outcome_unknown" };

/**
 * Optional sender-supplied notification content. `body` is forwarded
 * to Rome Cloud unchanged — including empty/whitespace strings; Rome Cloud is the
 * authoritative content-normalization, fallback, truncation, and payload-
 * enforcement point (the action `inputSchema` is a separate agent-input
 * validation layer). An absent `body` (no arg, or `{}`) sends no HTTP body.
 */
export interface NotifyContent {
  body?: string;
}

export interface NotifyService {
  send(content?: NotifyContent): Promise<SendOutcome>;
}

/** How a push asks the phone to present it: `active` alerts, `passive` arrives silently. */
export type NotifyLevel = "active" | "passive";

/**
 * A push the instance sends on its own, outside the `send_notification`
 * action. `level` and `chatId` are routing data for Rome Cloud and the phone:
 * how the push is presented and which chat a tap opens. They are never shown,
 * so `body` stays the only displayed sender content. Main-process only: no
 * worker or agent input reaches these fields.
 */
export interface SystemNotifyContent extends NotifyContent {
  level?: NotifyLevel;
  chatId?: string;
  /**
   * The Rome Cloud account of the visitor the push is for. Absent, the push
   * is for the guardian. A Rome Cloud that does not know the field refuses
   * the request, so a visitor's push never falls back to the guardian.
   */
  recipient?: string;
}

const HTTP_TIMEOUT_MS = 120_000;

export interface NotifyClientDeps {
  getToken?: () => string | null | Promise<string | null>;
  getOrigin?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Main-process sender for the `send_notification` action and the Concierge's
 * proactive pushes. Reads the
 * current Rome Cloud bearer and origin **fresh on every call** (never
 * cached, never from `ROME_INSTANCE_TOKEN`) so token rotation/revocation is
 * honored, and never mutates the token store — clearing a rejected token stays
 * owned by the existing enrollment/heartbeat flow.
 */
export class NotifyClient implements NotifyService {
  private readonly getToken: () => string | null | Promise<string | null>;
  private readonly getOrigin: () => string | null;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps: NotifyClientDeps = {}) {
    this.getToken = deps.getToken ?? cloudBearer;
    this.getOrigin = deps.getOrigin ?? getRomeCloudOrigin;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.timeoutMs = deps.timeoutMs ?? HTTP_TIMEOUT_MS;
  }

  async send(content?: SystemNotifyContent): Promise<SendOutcome> {
    const token = await this.getToken();
    if (!token) return { kind: "no_token" };
    const origin = this.getOrigin();
    if (!origin) return { kind: "unconfigured" };
    // URL construction is a pre-dispatch configuration seam. Let an invalid
    // configured origin throw rather than reporting delivery as ambiguous when
    // no request could have been sent.
    const url = new URL("/api/notify", origin);

    // Only attach a JSON body when a field is supplied. Absent content sends no
    // HTTP body; an empty/whitespace string is forwarded unchanged — Rome Cloud
    // owns the fallback decision.
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let requestBody: string | undefined;
    const fields = {
      ...(content?.body !== undefined ? { body: content.body } : {}),
      ...(content?.level !== undefined ? { level: content.level } : {}),
      ...(content?.chatId !== undefined ? { chatId: content.chatId } : {}),
      ...(content?.recipient !== undefined ? { recipient: content.recipient } : {}),
    };
    if (Object.keys(fields).length > 0) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(fields);
    }

    // The abort signal must stay live across BOTH the fetch AND the body read,
    // so a stalled `res.json()` also aborts within the budget (clearing the
    // timer after headers arrive would leave the body read unbounded).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers,
        body: requestBody,
        signal: controller.signal,
      });
      if (res.status === 403 && content?.recipient !== undefined) {
        if ((await errorCode(res)) === "recipient_not_allowed") {
          return { kind: "recipient_not_allowed" };
        }
        return { kind: "reenroll" };
      }
      // 401/403 are terminal auth signals. We do NOT clear the
      // token here; the heartbeat/enrollment flow owns that.
      if (res.status === 401 || res.status === 403) {
        await cancelUnreadBody(res);
        return { kind: "reenroll" };
      }
      if (!res.ok) {
        await cancelUnreadBody(res);
        return { kind: "outcome_unknown" };
      }
      const body: unknown = await res.json();
      if (!isCounts(body)) return { kind: "outcome_unknown" };
      // An older Rome Cloud sends no `reason`, and its counts stand as they are.
      if ((body as { reason?: unknown }).reason === "not_hosted" && body.attempted === 0) {
        return { kind: "not_hosted" };
      }
      // A Rome Cloud that served the recipient echoes it. One that answers
      // without it may have sent the push to the guardian's devices instead.
      if (content?.recipient !== undefined) {
        const served = (body as { recipient?: unknown }).recipient;
        if (served !== content.recipient) return { kind: "outcome_unknown" };
      }
      return { kind: "ok", attempted: body.attempted, sent: body.sent, failed: body.failed };
    } catch {
      return { kind: "outcome_unknown" }; // network error, abort/timeout, or unparseable body
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The `error` code of a JSON error body, or null when there is none. */
async function errorCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    const code =
      typeof body === "object" && body !== null ? (body as { error?: unknown }).error : null;
    return typeof code === "string" ? code : null;
  } catch {
    return null;
  }
}

async function cancelUnreadBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Best-effort cleanup must not replace the status-derived outcome.
  }
}

// Defensive: the real broker returns non-negative integers with
// sent + failed === attempted by construction (route.ts), but validate the
// invariant so a broker bug or version skew degrades to outcome_unknown rather
// than a nonsensical result like { attempted: 0, sent: 1, failed: 0 }.
function isCounts(v: unknown): v is { attempted: number; sent: number; failed: number } {
  if (typeof v !== "object" || v === null) return false;
  const { attempted, sent, failed } = v as Record<string, unknown>;
  const ok = (n: unknown): n is number =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!ok(attempted) || !ok(sent) || !ok(failed)) return false;
  return sent + failed === attempted;
}
