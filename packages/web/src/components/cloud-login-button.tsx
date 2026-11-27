import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AuthActionButton } from "@/components/auth-screen";
import { beginCloudLogin } from "@/lib/cloud-login";

// "Continue with Rome Cloud", the primary action shared by /login and /connect;
// rendered only when the backend reports `cloudAuthEnabled`. On success the
// browser navigates to Rome Cloud, so this only re-enables itself on a start
// failure. Callback failures come back as ?cloud=error&reason=… and are surfaced
// by the host page, not here. `autoStart` runs the same start once on mount, in
// place of the click. `chooseAccount` adds a quiet "Use another account" link
// that starts the same sign-in but asks Rome Cloud to let the person pick an
// account first. Both share one busy state, so only one attempt (and one state
// cookie) is ever in flight.
export function CloudLoginButton({
  onStartError,
  autoStart = false,
  chooseAccount = false,
}: {
  onStartError: (message: string) => void;
  autoStart?: boolean;
  chooseAccount?: boolean;
}) {
  const { t } = useTranslation("auth");
  const [starting, setStarting] = useState(false);
  // Survives StrictMode's double effect run, so one mount starts one attempt.
  const autoStarted = useRef(false);
  // Blocks a second start before the busy state has re-rendered.
  const inFlight = useRef(false);

  const start = useCallback(
    async (options: { chooseAccount?: boolean } = {}) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setStarting(true);
      onStartError("");
      let result;
      try {
        result = await beginCloudLogin(options);
      } catch {
        result = { ok: false, reason: "start" } as const;
      }
      if (!result.ok) {
        onStartError(result.reason === "network" ? t("networkError") : t("cloud.errorStart"));
        inFlight.current = false;
        setStarting(false);
      }
    },
    [onStartError, t],
  );

  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    void start();
  }, [autoStart, start]);

  return (
    <>
      <AuthActionButton busy={starting} busyLabel={t("cloud.connecting")} onClick={() => start()}>
        {t("cloud.signIn")}
      </AuthActionButton>
      {chooseAccount && (
        <button
          type="button"
          disabled={starting}
          onClick={() => void start({ chooseAccount: true })}
          className="mx-auto mt-4 block text-ui text-muted-foreground hover:text-foreground focus:outline-none focus-visible:underline disabled:opacity-50"
        >
          {t("login.useAnotherAccount")}
        </button>
      )}
    </>
  );
}

// The reasons the cloud-login callback can hand back. Anything outside
// the set falls through to the generic fallback message.
const CLOUD_ERROR_REASONS = new Set([
  "state",
  "expired",
  "denied",
  "iss",
  "unconfigured",
  "exchange",
  "malformed",
  "network",
  "account_mismatch",
  "not_owner",
  "link_required",
  "revoked",
]);

export function cloudErrorReasonKey(reason: string | null): string {
  if (reason && CLOUD_ERROR_REASONS.has(reason)) {
    const camel = reason.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
    return `cloud.error${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
  }
  return "cloud.errorFallback";
}
