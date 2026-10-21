/**
 * Client types + fetchers for the generic conferral-setup surface.
 * The state/content types mirror the backend `SetupState` verbatim — payloads
 * are semantically complete (copy authored server-side), so the standard
 * renderers narrate any setup from these shapes alone. Per-`(connection kind, state)`
 * custom components override rendering only; they never need extra data.
 */

// ── Content schema (mirror of packages/core/.../setup/types.ts) ──────────

export interface SetupFormField {
  name: string;
  label: string;
  secret: boolean;
  format?: "line" | "multiline" | "file";
  options?: string[];
}

export interface SetupViewLink {
  label: string;
  url: string;
}

export interface SetupViewStep {
  text: string;
  done?: boolean;
}

export interface SetupForm {
  instructions?: string;
  /** A numbered how-to shown above the fields (e.g. the BotFather walkthrough). */
  steps?: SetupViewStep[];
  /** Labeled external links shown with the guide (e.g. @BotFather, the Portal). */
  links?: SetupViewLink[];
  fields: SetupFormField[];
  /** A closing aside shown below the fields (e.g. a troubleshooting note). */
  note?: string;
}

export interface SetupView {
  title?: string;
  body?: string[];
  links?: SetupViewLink[];
  steps?: SetupViewStep[];
  /** A QR code for the guardian to scan, as a `data:` image URL (the raw
   *  content string rides along in `links`). */
  qr?: string;
  progress?: boolean;
}

export interface SetupDoneView {
  summary?: SetupView;
  /** The connection the setup connected, so a setup for a new account can
   *  open the account it made. Absent from a core that predates it. */
  connectionId?: string;
}

export type SetupState =
  | { status: "awaiting-input"; form: SetupForm; error?: string }
  | { status: "awaiting-redirect"; url: string }
  | { status: "presenting"; view: SetupView }
  | { status: "done"; conferral: SetupDoneView }
  | { status: "failed"; reason: string }
  | { status: "cancelled" };

/** A setup that has reached a terminal state needs no further polling. */
export function isTerminalSetup(state: SetupState): boolean {
  return state.status === "done" || state.status === "failed" || state.status === "cancelled";
}

// ── Fetchers (non-throwing where the caller drives UI on the result) ────────

export interface SetupStart {
  cid: string;
  state: SetupState;
  reattached: boolean;
}

export type SetupStartResult = { ok: true; start: SetupStart } | { ok: false; error: string };

/** Start or re-attach a setup for one grant. `idOrKind` is the connection
 *  id, or the bare connection kind for a never-connected connection kind (the terminal
 *  conferral mints the row). With `another`, `idOrKind` is the connection kind and
 *  the setup connects a new account of it. */
export async function startSetup(
  idOrKind: string,
  grant: string,
  opts: { force?: boolean; another?: boolean } = {},
): Promise<SetupStartResult> {
  const res = await fetch(
    `/api/connections/${encodeURIComponent(idOrKind)}/grants/${encodeURIComponent(grant)}/setup`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        force: opts.force ?? false,
        ...(opts.another ? { another: true } : {}),
      }),
    },
  );
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: payload?.error || "Failed to start the setup." };
  }
  return { ok: true, start: (await res.json()) as SetupStart };
}

/** Poll a setup's current state; null when the setup is unknown (404). */
export async function getSetupState(cid: string): Promise<SetupState | null> {
  const res = await fetch(`/api/setups/${encodeURIComponent(cid)}`);
  if (!res.ok) return null;
  const payload = (await res.json()) as { state: SetupState };
  return payload.state;
}

export interface SetupInputOutcome {
  accepted: boolean;
  reason?: string;
  state: SetupState;
}

export type SetupInputResult =
  | { ok: true; outcome: SetupInputOutcome }
  | { ok: false; error: string };

/** Submit the guardian's answers to a setup awaiting input. A non-accepted
 *  input (409, late/double delivery) still returns `ok: true` with the outcome
 *  so the caller can re-poll rather than treat it as a hard error. */
export async function submitSetupInput(
  cid: string,
  answers: Record<string, string>,
): Promise<SetupInputResult> {
  const res = await fetch(`/api/setups/${encodeURIComponent(cid)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answers }),
  });
  if (res.status === 404) {
    return { ok: false, error: "This setup is no longer active." };
  }
  const payload = (await res.json().catch(() => null)) as SetupInputOutcome | null;
  if (!payload) return { ok: false, error: "Failed to submit." };
  return { ok: true, outcome: payload };
}

/** The outcome of delivering a redirect return leg (the OAuth callback). */
export interface SetupReturnResult {
  /** A setup owns this redirect `state` — live, already finished with it, or
   *  cancelled while holding it. The last two return `matched:true,
   *  accepted:false` so a replayed leg (a reload of the callback page) cannot
   *  fall through to the sign-in redeem. When false, no setup owns the state
   *  (unknown/expired, or a flow that never started a setup, e.g. sign-in). */
  matched: boolean;
  /** Whether THIS delivery resumed the coroutine (200) vs. lost a race to a
   *  concurrent delivery (409, `accepted:false`). Preserved distinct from
   *  `matched` so the caller isn't forced to treat a race like a clean accept:
   *  either way a setup owns this `state`, so the caller must NOT fall through to
   *  the redeem (the handoff is being consumed), but the signal is available. */
  accepted?: boolean;
  /** True when the delivery could NOT be resolved — a network failure or a 5xx —
   *  as opposed to a DEFINITIVE no-match (404). The request may have reached the
   *  server and consumed the handoff, so the caller must NOT dead-end on the
   *  sign-in redeem (which would fail on the already-consumed attempt and show a
   *  confusing error for a setup that actually connected); it re-polls instead. */
  ambiguous?: boolean;
  cid?: string;
  /** The connection kind of the matched setup — where the guardian returns to
   *  watch it settle. Absent when nothing matched. */
  connectionKind?: string;
  state?: SetupState;
}

/** Deliver a redirect return leg to whichever setup is awaiting this `state` (the
 *  OAuth out-and-back). Non-throwing: a network failure or 5xx reports
 *  `matched:false, ambiguous:true`; a 404 is a definitive `matched:false` so the
 *  caller can safely fall through to the sign-in redeem. */
export async function submitSetupReturn(params: {
  state: string;
  handoff?: string;
  error?: string;
}): Promise<SetupReturnResult> {
  const res = await fetch(`/api/setups/return`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify(params),
  }).catch(() => null);
  // A network failure is ambiguous — the server may have received it.
  if (!res) return { matched: false, ambiguous: true };
  const payload = (await res.json().catch(() => null)) as
    | (SetupReturnResult & Record<string, unknown>)
    | null;
  if (payload?.matched) {
    return {
      matched: true,
      accepted: payload.accepted === true,
      cid: payload.cid,
      ...(typeof payload.connectionKind === "string"
        ? { connectionKind: payload.connectionKind }
        : {}),
      state: payload.state,
    };
  }
  // Not matched. A 5xx is ambiguous (the confer may have landed); a 404 (or any
  // 4xx) is a definitive no-match the caller can fall back on.
  return res.status >= 500 ? { matched: false, ambiguous: true } : { matched: false };
}

/** Cancel a setup; returns its terminal state, or null when unknown. */
export async function cancelSetup(cid: string): Promise<SetupState | null> {
  const res = await fetch(`/api/setups/${encodeURIComponent(cid)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) return null;
  const payload = (await res.json()) as { state: SetupState };
  return payload.state;
}
