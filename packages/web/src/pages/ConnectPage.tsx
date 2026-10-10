import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
    <main className="relative flex min-h-dvh items-center justify-center bg-surface-muted px-4 pb-safe pt-safe">
      <div className="absolute right-4 top-[calc(1rem+var(--rome-safe-area-top))]">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-title text-foreground">{t("connect.title")}</h1>
        <p className="mb-8 text-center text-ui text-muted-foreground">{t("connect.description")}</p>

        <div className="rounded-12 border border-border bg-surface p-6 shadow-1 sm:p-8">
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            size="md"
            className="w-full touch-target"
            disabled={starting}
            onClick={() => void startEnroll()}
          >
            {starting ? t("connect.connecting") : t("connect.connect")}
          </Button>
        </div>
      </div>
    </main>
  );
}
