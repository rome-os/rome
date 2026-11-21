import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { AuthActionButton, AuthError, AuthScreen } from "@/components/auth-screen";
import { beginInstanceEnroll } from "@/lib/instance-enroll";

// The set of reasons the enroll callback can hand back. Anything
// outside it falls through to the generic fallback message.
const ERROR_REASONS = new Set([
  "state",
  "expired",
  "denied",
  "unconfigured",
  "exchange",
  "malformed",
  "network",
]);

function reasonKey(reason: string | null): string {
  if (reason && ERROR_REASONS.has(reason)) {
    return `connect.error${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
  }
  return "connect.errorFallback";
}

export default function ConnectPage() {
  const { t } = useTranslation("auth");
  const [searchParams] = useSearchParams();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");

  // The instance-enroll callback bounces failures back here as
  // ?enroll=error&reason=… . Surface it until the next attempt clears it. (Cloud
  // sign-in failures land on /login, never here.)
  const enrollCallbackError =
    searchParams.get("enroll") === "error" ? t(reasonKey(searchParams.get("reason"))) : "";
  const error = startError || enrollCallbackError;

  async function startEnroll() {
    setStarting(true);
    setStartError("");
    const result = await beginInstanceEnroll();
    // On success the browser navigates away to Rome Cloud; we only land here on
    // failure, so re-enable the button and surface why.
    if (!result.ok) {
      setStartError(result.reason === "network" ? t("networkError") : t("connect.errorStart"));
      setStarting(false);
    }
  }

  return (
    <AuthScreen title={t("connect.title")}>
      <AuthActionButton
        busy={starting}
        busyLabel={t("connect.connecting")}
        onClick={() => void startEnroll()}
      >
        {t("connect.connect")}
      </AuthActionButton>
      {error && <AuthError>{error}</AuthError>}
    </AuthScreen>
  );
}
