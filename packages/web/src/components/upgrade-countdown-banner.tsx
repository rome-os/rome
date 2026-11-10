import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import { IconButton } from "./ui/icon-button";
import { estimatedServerNow, type UseUpgradeStatusResult } from "../hooks/use-upgrade-status";

/**
 * Global top banner fronting the upgrade consent countdown. Persistent and
 * non-blocking, so the prompt itself doesn't disrupt a guardian mid-task.
 * Four states, driven by useUpgradeStatus's poll loop (owned by the shell, which
 * also hides the sidebar's upgrade arrow while this is up): countdown (the human
 * gate), updating (the restart, tracked client-side so it survives the server
 * going away), stalled (restart overdue — dismissable), hidden. The desktop
 * app renders the same SPA, so this covers both.
 */
export function UpgradeCountdownBanner({ status }: { status: UseUpgradeStatusResult }) {
  const { t } = useTranslation("common");
  const { state, updateNow, defer, dismissStalled } = status;
  const [busy, setBusy] = useState(false);
  const [verbFailed, setVerbFailed] = useState(false);

  // The banner stays mounted across offers, so a retry hint must not outlive
  // the offer it belongs to: any phase change or a new deadline (a fresh
  // offer) clears it.
  const phase = state?.phase ?? null;
  const deadline = state?.phase === "countdown" ? state.deadline : null;
  useEffect(() => {
    setVerbFailed(false);
  }, [phase, deadline]);

  if (!state) return null;

  const run = (fn: () => Promise<boolean>) => async () => {
    setBusy(true);
    setVerbFailed(false);
    try {
      const ok = await fn();
      if (!ok) setVerbFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-none fixed top-3 left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 px-3">
      <Alert
        variant={state.phase === "stalled" ? "warning" : "info"}
        className="pointer-events-auto flex w-full items-start gap-3 px-3 py-2 shadow-1"
      >
        {state.phase === "updating" && (
          <div className="flex-1">
            <AlertTitle>{t("upgradeBanner.updatingTitle")}</AlertTitle>
            <AlertDescription className="mt-1">{t("upgradeBanner.updatingBody")}</AlertDescription>
          </div>
        )}
        {state.phase === "stalled" && (
          <>
            <div className="flex-1">
              <AlertTitle>{t("upgradeBanner.stalledTitle")}</AlertTitle>
              <AlertDescription className="mt-1">{t("upgradeBanner.stalledBody")}</AlertDescription>
            </div>
            <IconButton
              size="sm"
              label={t("upgradeBanner.dismiss")}
              icon={<X />}
              onClick={dismissStalled}
            />
          </>
        )}
        {state.phase === "countdown" && (
          <>
            <div className="flex-1">
              <AlertTitle>
                {t("upgradeBanner.countdownTitle", {
                  version: state.targetVersion ?? "",
                })}
              </AlertTitle>
              <AlertDescription className="mt-1">
                {t("upgradeBanner.countdownBody", { remaining: formatRemaining(state) })}
              </AlertDescription>
              {verbFailed && (
                <p className="mt-1 text-destructive">{t("upgradeBanner.verbFailed")}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" onClick={() => void run(updateNow)()} disabled={busy}>
                {busy ? t("upgradeBanner.applying") : t("upgradeBanner.updateNow")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void run(defer)()} disabled={busy}>
                {t("upgradeBanner.remindLater")}
              </Button>
            </div>
          </>
        )}
      </Alert>
    </div>
  );
}

/** mm:ss until the server deadline, corrected for browser↔server clock skew via
 * the captured `serverNow`/`receivedAt` pair. Never negative. */
function formatRemaining(status: {
  deadline: number | null;
  serverNow: number;
  receivedAt: number;
}): string {
  if (status.deadline === null) return "0:00";
  const totalSeconds = Math.max(
    0,
    Math.round((status.deadline - estimatedServerNow(status)) / 1000),
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
