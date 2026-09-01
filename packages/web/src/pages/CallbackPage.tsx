import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { submitSetupReturn } from "@/lib/setup-api";

interface OAuthRedeemPayload {
  nextPath?: string;
  error?: string;
}

const redeemRequests = new Map<string, Promise<OAuthRedeemPayload>>();

/** The connections list — where a return leg lands when it cannot name the
 *  service it belongs to (nothing matched, or an ambiguous delivery). */
const SETTINGS_CONNECTIONS_PATH = "/settings/connections";

/** Where a settings-dashboard OAuth setup lands once its return leg is
 *  delivered: the connection's own detail page, the only surface that renders
 *  `OAuthConnectionSection` and so the only one that re-attaches to the (possibly
 *  still-redeeming) setup and settles it to connected. Falls back to the list
 *  when the service is unknown. */
function connectionPath(service: string | undefined): string {
  return service
    ? `${SETTINGS_CONNECTIONS_PATH}/${encodeURIComponent(service)}`
    : SETTINGS_CONNECTIONS_PATH;
}

/** The outcome of handling one OAuth return leg. `redirect` is where to send the
 *  guardian; `error` is a terminal failure to show instead; `delivered` means the
 *  leg reached its setup from a browser with no dashboard session of its own —
 *  the desktop shell's hand-off to the system browser — so there is nowhere to
 *  send it and the page has to be the ending.
 *
 *  Deliberately NOT `connected`. A resumed setup is typically still `presenting`
 *  while it redeems, and the redeem or the conferral commit can still fail —
 *  delivery is the most this browser can honestly report. It cannot wait for
 *  `done` either: `/api/setups/:cid` stays private, so an anonymous browser has
 *  no way to poll for the real outcome. */
type ReturnOutcome =
  | { redirect: string }
  | { error: string }
  | { delivered: true }
  | { cancelled: true }
  /** A setup this browser owns came back failed, and the browser has no
   *  dashboard session — the desktop shell's system browser. The generic error
   *  view offers "Return to login", which is the wrong instruction for someone
   *  who was connecting an account, not signing in. Scoped to a MATCHED setup:
   *  an ambiguous return still cannot tell a connect from a sign-in, so it keeps
   *  the existing handling rather than guessing. */
  | { connectionFailed: string };

/**
 * Whether this browser holds a dashboard session.
 *
 * Deliberately a bare fetch and NOT the `useAuthState` query. That key is owned
 * by the auth gate — it is the sole fetcher — and is cached with `staleTime:
 * Infinity`, invalidated only by the login and onboard mutations. Seeding it
 * from here would let the SIGN-IN leg, which by definition runs before its own
 * cookie exists, park `needs-signin` in the cache; the gate would then reuse
 * that stale answer after the redeem and bounce the user back to /login on a
 * successful sign-in.
 *
 * The question is only ever "is this browser anonymous". A `visitor` is as much
 * a dashboard session as a `guardian`, so this reads as a negative rather than
 * an enumeration of the kinds that count.
 */
async function hasDashboardSession(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (!response.ok) return true;
    const identity = (await response.json()) as { kind?: string };
    return identity.kind !== "anonymous";
  } catch {
    // Can't tell: keep the navigation this flow has always done rather than
    // stranding a dashboard user on a page that tells them to go back to Rome.
    return true;
  }
}

// Dedup by `(state, handoff, providerError)` so React's double-invoked effects
// deliver each single-use return leg ONCE. Like `redeemRequests`, an entry is
// pruned only on rejection; a resolved entry is retained for the page's lifetime
// (deliberate — the dedup must hold for repeat effect runs). `state` is
// single-use and the callback page is short-lived (it navigates away on
// success), so the map holds at most a handful of entries and never grows
// unbounded.
const returnHandlers = new Map<string, Promise<ReturnOutcome>>();

/**
 * Handle a single OAuth return leg, deduped per `(state, handoff)` so React's
 * double-invoked effects (and any accidental double delivery) resume the setup
 * ONCE.
 *
 * Two features land on this one callback, and the URL can't tell them apart, so
 * the connection-setup path is tried first:
 *  - CONNECT a provider — a connection setup (the layer that unifies channels +
 *    connectors). A live setup is suspended at the redirect awaiting this
 *    `state`; delivering the leg to it resumes the coroutine, which redeems via
 *    the OAuth primitive and confers. This is the #1611 path.
 *  - SIGN IN with the provider — authentication (guardian → Rome Cloud account),
 *    NOT a connection. No setup is waiting, so this falls through to
 *    `/oauth/redeem`, which redeems the SAME OAuth primitive and also
 *    issues the guardian session. It also catches a connect whose in-memory
 *    setup was lost to a restart. `/oauth/redeem` persists as the sign-in entry,
 *    not as debt — sign-in is simply outside the connections concept.
 */
function handleOAuthReturnOnce(
  handoff: string,
  state: string,
  providerError: string | null,
  fallbackError: string,
): Promise<ReturnOutcome> {
  const key = `${state}:${handoff}:${providerError ?? ""}`;
  const existing = returnHandlers.get(key);
  if (existing) return existing;

  const run = (async (): Promise<ReturnOutcome> => {
    // Deliver the leg (or the broker error) to a suspended setup, if any.
    const returned = await submitSetupReturn({
      state,
      ...(handoff ? { handoff } : {}),
      ...(providerError ? { error: providerError } : {}),
    });
    if (returned.matched) {
      // Cancellation still owns its redirect state. Stop here so a late browser
      // return cannot fall through to the sign-in redeem and import a credential
      // after the guardian explicitly cancelled the connection in Rome.
      if (returned.state?.status === "cancelled") return { cancelled: true };
      if (returned.state?.status === "failed") {
        const reason = returned.state.reason || fallbackError;
        if (!(await hasDashboardSession())) return { connectionFailed: reason };
        return { error: reason };
      }
      // Only a MATCHED setup asks. The sign-in leg below must not probe
      // identity: it runs before its own session exists, so the answer would be
      // both wrong and useless there.
      if (!(await hasDashboardSession())) return { delivered: true };
      // The setup consumed the leg and is finishing the redeem; the connection's
      // detail page re-attaches and settles it.
      return { redirect: connectionPath(returned.service) };
    }

    // A broker error (denied consent) means no connection could have succeeded —
    // show it rather than routing anywhere.
    if (providerError) return { error: providerError };

    // Ambiguous (network / 5xx): the return MAY have reached the server and
    // consumed the handoff (the setup could have connected), so falling back to
    // the redeem would dead-end on an already-consumed attempt. Send the guardian
    // to the connections list to see the real state instead — an ambiguous
    // delivery carries no service to address.
    if (returned.ambiguous) return { redirect: connectionPath(returned.service) };

    // Definitive no-match — the sign-in / lost-session fallback.
    if (!handoff) return { error: fallbackError };
    const payload = await redeemOAuthHandoffOnce(handoff, state, fallbackError);
    return { redirect: payload?.nextPath || "/" };
  })().catch((error) => {
    returnHandlers.delete(key);
    throw error;
  });

  returnHandlers.set(key, run);
  return run;
}

function redeemOAuthHandoffOnce(
  handoff: string,
  state: string,
  fallbackError: string,
): Promise<OAuthRedeemPayload> {
  const requestKey = `${state}:${handoff}`;
  const existing = redeemRequests.get(requestKey);
  if (existing) return existing;

  const request = fetch("/api/oauth/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    credentials: "include",
    body: JSON.stringify({ handoff, state }),
  })
    .then(async (response) => {
      const payload = (await response.json().catch(() => null)) as OAuthRedeemPayload | null;
      if (!response.ok) {
        throw new Error(payload?.error || fallbackError);
      }
      return payload ?? {};
    })
    .catch((error) => {
      redeemRequests.delete(requestKey);
      throw error;
    });

  redeemRequests.set(requestKey, request);
  return request;
}

export default function CallbackPage() {
  const { t } = useTranslation("auth");
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const handoff = searchParams.get("handoff");
  const state = searchParams.get("state");
  const providerError = searchParams.get("error");
  const [error, setError] = useState<string | null>(providerError);
  const [setupCancelled, setSetupCancelled] = useState(false);
  // A failed connection reported to a browser with no dashboard session: the
  // reason to show, with no login link under it.
  const [connectionFailed, setConnectionFailed] = useState<string | null>(null);
  // The leg reached its setup from a browser with no dashboard session — the
  // system browser the desktop shell handed off to. There is nowhere to
  // navigate it, so the page has to be the ending.
  const [delivered, setDelivered] = useState(false);

  useEffect(() => {
    // The `state` is the return-leg correlation for BOTH features (connect-setup
    // resume and sign-in redeem); a broker error with no state has nothing to
    // correlate.
    if (!state) {
      setError(providerError ?? t("callback.errorMissingState"));
      return;
    }
    // A clean (non-error) leg still needs the handoff for the sign-in redeem;
    // a setup resume can proceed on state alone.
    if (!handoff && !providerError) {
      setError(t("callback.errorMissingHandoff"));
      return;
    }

    const handoffCode = handoff ?? "";
    const oauthState = state;
    const brokerError = providerError;
    const fallbackError = t("callback.errorRedeemFailed");
    let cancelled = false;

    async function finish() {
      try {
        const outcome = await handleOAuthReturnOnce(
          handoffCode,
          oauthState,
          brokerError,
          fallbackError,
        );
        if (cancelled) return;
        if ("error" in outcome) {
          setError(outcome.error);
          return;
        }
        if ("delivered" in outcome) {
          setDelivered(true);
          return;
        }
        if ("cancelled" in outcome) {
          setSetupCancelled(true);
          return;
        }
        if ("connectionFailed" in outcome) {
          setConnectionFailed(outcome.connectionFailed);
          return;
        }
        navigate(outcome.redirect, { replace: true });
      } catch (returnError) {
        if (cancelled) return;
        setError(returnError instanceof Error ? returnError.message : fallbackError);
      }
    }

    finish();

    return () => {
      cancelled = true;
    };
  }, [handoff, state, providerError, navigate, t]);

  // An up-to-date broker attaches a readable error_description that core
  // relays as-is; a bare RFC 6749 code (deploy skew, older broker) would
  // otherwise surface verbatim — translate the one users actually hit. A setup
  // failure can relay the same code, so both readings go through it.
  const readable = (reason: string | null) =>
    reason === "invalid_grant" ? t("callback.errorInvalidGrant") : reason;
  const displayError = readable(error);
  const displayConnectionFailure = readable(connectionFailed);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-muted px-4 pb-safe pt-safe">
      <div className="w-full max-w-md rounded-12 border border-border bg-surface p-6 shadow-1">
        <h1 className="text-title text-foreground">
          {displayConnectionFailure
            ? t("callback.connectionFailedTitle")
            : setupCancelled
              ? t("callback.cancelledTitle")
              : delivered
                ? t("callback.deliveredTitle")
                : t("callback.title")}
        </h1>
        {displayConnectionFailure ? (
          // No login link: this browser was connecting an account, not signing
          // in, and it has no session to return to anyway.
          <>
            <p className="mt-3 text-ui text-destructive-fg">{displayConnectionFailure}</p>
            <p className="mt-3 text-body text-muted-foreground">
              {t("callback.connectionFailedBody")}
            </p>
          </>
        ) : displayError ? (
          <>
            <p className="mt-3 text-ui text-destructive-fg">{displayError}</p>
            <a
              href="/login"
              className="mt-5 inline-flex rounded-8 bg-primary px-4 py-2 text-ui text-primary-foreground hover:bg-primary-hover"
            >
              {t("callback.returnToLogin")}
            </a>
          </>
        ) : setupCancelled ? (
          <p className="mt-3 text-body text-muted-foreground">{t("callback.cancelledBody")}</p>
        ) : delivered ? (
          <p className="mt-3 text-body text-muted-foreground">{t("callback.deliveredBody")}</p>
        ) : (
          <p className="mt-3 text-body text-muted-foreground">{t("callback.description")}</p>
        )}
      </div>
    </main>
  );
}
