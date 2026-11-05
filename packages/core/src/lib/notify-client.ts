import { cloudBearer } from "./instance-identity.js";
import { getRomeCloudOrigin } from "./rome-cloud-origin.js";

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

const HTTP_TIMEOUT_MS = 120_000;

export interface NotifyClientDeps {
  getToken?: () => string | null | Promise<string | null>;
  getOrigin?: () => string | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Main-process sender for the `send_notification` action. Reads the
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

  async send(content?: NotifyContent): Promise<SendOutcome> {
    const token = await this.getToken();
    if (!token) return { kind: "no_token" };
    const origin = this.getOrigin();
    if (!origin) return { kind: "unconfigured" };
    // URL construction is a pre-dispatch configuration seam. Let an invalid
    // configured origin throw rather than reporting delivery as ambiguous when
    // no request could have been sent.
    const url = new URL("/api/notify", origin);

    // Only attach a JSON body when a `body` is supplied. Absent content sends no
    // HTTP body; an empty/whitespace string is forwarded unchanged — Rome Cloud
    // owns the fallback decision.
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    let requestBody: string | undefined;
    if (content?.body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify({ body: content.body });
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
      return { kind: "ok", attempted: body.attempted, sent: body.sent, failed: body.failed };
    } catch {
      return { kind: "outcome_unknown" }; // network error, abort/timeout, or unparseable body
    } finally {
      clearTimeout(timer);
    }
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
