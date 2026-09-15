import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  CircleCheck,
  Copy,
  ExternalLink,
  Info,
  RotateCcw,
} from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";

import {
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Safari } from "@/components/ui/safari";
import { Stepper } from "@/components/ui/stepper";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const STATUS_POLL_INTERVAL_MS = 2000;
// Hold the success state on screen briefly so the user sees a confirmed
// "signed in" before the modal auto-closes, rather than it just vanishing.
const CONNECTED_DISPLAY_MS = 1400;

const CHATGPT_SECURITY_URL = "https://chatgpt.com/#settings/Security";
const CHATGPT_SETTINGS_IMAGE = "/assets/guides/codex-device-code-chatgpt-setting.png";

// Two guided steps: enable the ChatGPT setting → copy the device code and open
// the verification page (authorizing happens on OpenAI's own page in a new tab).
// `connected` short-circuits both with a success confirmation once codex reports
// a completed login.
const STEP_ENABLE = 0;
const STEP_COPY = 1;

interface CodexDeviceLoginModalProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface AiToolsStatus {
  codex?: { loggedIn?: boolean };
  codexDeviceLogin?: {
    running?: boolean;
    userCode?: string | null;
    verificationUrl?: string | null;
    lastError?: string | null;
  };
}

/**
 * The single implementation of Codex's device-code login, as a 2-step guided
 * wizard. Drives the backend app-server flow (`/ai-tools/codex/device-login/*`):
 * walks the guardian through enabling the ChatGPT setting, then copying the
 * device code and opening OpenAI's verification page, and polls `/ai-tools/status`
 * until codex reports `loggedIn`. Mirrors `chatgpt-login-modal.tsx`'s lifecycle
 * (stable callback refs, completion guard) so both Settings and onboarding can
 * import it and hold only an `open` boolean.
 */
export function CodexDeviceLoginModal({ open, onClose, onConnected }: CodexDeviceLoginModalProps) {
  const { t } = useTranslation("onboard");
  const [step, setStep] = useState(STEP_ENABLE);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  // Two independent error sources: a failed start request (local only) and the
  // backend's `lastError` (a failed/expired completion). Keep them apart so the
  // poll can mirror the backend exactly — including clearing it — without
  // wiping a start failure, and so a stale error never lingers beside a fresh
  // code.
  const [startError, setStartError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const error = startError ?? statusError;
  const [copied, setCopied] = useState(false);
  // Sticky (unlike the transient `copied` flash): once the guardian has copied
  // the code, the "Open verification page" button unlocks. Gating it stops them
  // landing on OpenAI's page with nothing to paste.
  const [hasCopied, setHasCopied] = useState(false);
  // Codex reported a successful login — show a brief success confirmation, then
  // auto-close via the CONNECTED_DISPLAY_MS timer.
  const [connected, setConnected] = useState(false);
  const startedRef = useRef(false);
  const completedRef = useRef(false);
  const startInFlightRef = useRef(false);

  // Keep callback refs stable so the polling effect doesn't tear down on every
  // parent re-render (the parent passes inline lambdas).
  const onConnectedRef = useRef(onConnected);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onConnectedRef.current = onConnected;
    onCloseRef.current = onClose;
  }, [onConnected, onClose]);

  const start = useCallback(async () => {
    // Dedupe concurrent starts. React StrictMode double-invokes the open effect
    // in dev, and Retry can be clicked repeatedly — a second POST would make the
    // backend cancel the first app-server login id while its response is still
    // in flight, producing a spurious start failure beside the surviving code.
    if (startInFlightRef.current) return;
    startInFlightRef.current = true;
    setStarting(true);
    // A fresh start supersedes any earlier failure/expiry on both sides.
    setStartError(null);
    setStatusError(null);
    try {
      const res = await fetch("/api/ai-tools/codex/device-login/start", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setStartError(data.error || t("codexDeviceLogin.errors.startFailed"));
        return;
      }
      const data = (await res.json()) as { userCode?: string; verificationUrl?: string };
      setUserCode(data.userCode ?? null);
      setVerificationUrl(data.verificationUrl ?? null);
      // The fresh code is authoritative — drop any backend error a racing poll
      // may have surfaced from the just-superseded attempt.
      setStatusError(null);
      startedRef.current = true;
    } catch {
      setStartError(t("codexDeviceLogin.errors.startFailed"));
    } finally {
      startInFlightRef.current = false;
      setStarting(false);
    }
  }, [t]);

  // Reset state and kick off a fresh device code each time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep(STEP_ENABLE);
    setUserCode(null);
    setVerificationUrl(null);
    setStartError(null);
    setStatusError(null);
    setCopied(false);
    setHasCopied(false);
    setConnected(false);
    startedRef.current = false;
    completedRef.current = false;
    void start();
  }, [open, start]);

  // Poll AI status until codex reports loggedIn, and surface any failure the
  // backend recorded (expired / declined). Callbacks are read through refs so
  // the effect doesn't re-fire on every parent render.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function checkOnce() {
      if (cancelled || completedRef.current) return;
      try {
        const res = await fetch("/api/ai-tools/status");
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as AiToolsStatus;
        if (cancelled || completedRef.current) return;
        if (data.codex?.loggedIn) {
          completedRef.current = true;
          cancelled = true;
          // Show the success confirmation, then hand back to the parent (which
          // closes the modal) after a short beat.
          setConnected(true);
          setTimeout(() => onConnectedRef.current(), CONNECTED_DISPLAY_MS);
          return;
        }
        const deviceLogin = data.codexDeviceLogin;
        // Mirror the backend's error state exactly — null clears a stale error
        // so it never lingers beside a freshly issued code.
        setStatusError(deviceLogin?.lastError ?? null);
        // Recover the code if our local copy is gone (modal reopened mid-flow).
        if (deviceLogin?.userCode && deviceLogin.verificationUrl) {
          setUserCode((prev) => prev ?? deviceLogin.userCode ?? null);
          setVerificationUrl((prev) => prev ?? deviceLogin.verificationUrl ?? null);
        }
      } catch {
        /* ignore — keep polling */
      }
    }

    checkOnce();
    const timer = setInterval(checkOnce, STATUS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  const cancel = useCallback(() => {
    // Fire even while the initial `/start` is still in flight: the backend
    // sends `account/login/start` before `/start` returns, so guarding on
    // `startedRef` alone would leave that login id active until the 16-minute
    // timeout on a quick open→close. `/cancel` safely records cancellation
    // while the start response is still in flight.
    if (!startedRef.current && !startInFlightRef.current) return;
    fetch("/api/ai-tools/codex/device-login/cancel", { method: "POST" }).catch(() => {});
    startedRef.current = false;
  }, []);

  const handleClose = useCallback(() => {
    cancel();
    onClose();
  }, [cancel, onClose]);

  const handleRetry = useCallback(() => {
    setUserCode(null);
    setVerificationUrl(null);
    setCopied(false);
    setHasCopied(false);
    setStep(STEP_COPY);
    void start();
  }, [start]);

  const copyCode = useCallback(async () => {
    if (!userCode) return;
    // Unlock on the click itself, so a non-secure context where the clipboard
    // write throws doesn't trap the guardian (the code is selectable either way).
    setHasCopied(true);
    try {
      await navigator.clipboard.writeText(userCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (e.g. non-secure context); the code is selectable.
    }
  }, [userCode]);

  const stepLabels = [t("codexDeviceLogin.steps.enable"), t("codexDeviceLogin.steps.copy")];
  const stepTitle = connected
    ? t("codexDeviceLogin.title")
    : t(`codexDeviceLogin.${["enable", "copyCode"][step]}.title`);

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      ariaLabel={t("codexDeviceLogin.title")}
      modal
      className="flex max-h-[90vh] w-[min(96vw,720px)] max-w-none flex-col p-0"
    >
      <DialogHeader onClose={handleClose} closeLabel={t("codexDeviceLogin.cancel")}>
        <DialogTitle>{stepTitle}</DialogTitle>
      </DialogHeader>

      {connected ? (
        <DialogBody className="px-5 py-4">
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CircleCheck className="h-12 w-12 text-success-fg" aria-hidden />
            <p className="text-ui text-foreground">{t("codexDeviceLogin.connectedTitle")}</p>
            <p className="text-ui text-muted-foreground">{t("codexDeviceLogin.connectedBody")}</p>
          </div>
        </DialogBody>
      ) : (
        <>
          <DialogBody className="flex flex-col gap-5 overflow-y-auto px-5 py-4">
            <Stepper steps={stepLabels} current={step} />

            {error && (
              <Alert variant="destructive">
                <AlertTitle>{t("codexDeviceLogin.errors.title")}</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {step === STEP_ENABLE && (
              <div className="flex flex-col gap-4">
                <p className="text-ui text-muted-foreground">
                  <Trans
                    ns="onboard"
                    i18nKey="codexDeviceLogin.enable.body"
                    components={{
                      settingsLink: (
                        <a
                          href={CHATGPT_SECURITY_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-foreground underline underline-offset-2 hover:text-primary"
                        />
                      ),
                    }}
                  />
                </p>
                <Alert variant="info">
                  <Info className="h-4 w-4" aria-hidden />
                  <AlertDescription>{t("codexDeviceLogin.enable.adminNotice")}</AlertDescription>
                </Alert>
                <Safari
                  url="chatgpt.com/#settings/Security"
                  imageSrc={CHATGPT_SETTINGS_IMAGE}
                  overlay={
                    // Anchored just below the screenshot's highlighted toggle box
                    // (measured at ~84% down, toggle on its right). A bouncing
                    // arrow draws the eye to the switch the guardian must flip.
                    <div
                      className="pointer-events-none absolute z-20 flex -translate-x-1/2 flex-col items-center gap-0"
                      style={{ left: "61%", top: "85%" }}
                    >
                      <ArrowUp
                        className="h-9 w-9 animate-bounce text-[#f59e0b] [filter:drop-shadow(0_1px_2px_rgba(0,0,0,0.6))]"
                        strokeWidth={3}
                        aria-hidden
                      />
                      <span className="rounded-8 bg-[#f59e0b] px-3 py-1 text-badge text-black shadow-10">
                        {t("codexDeviceLogin.enable.pointer")}
                      </span>
                    </div>
                  }
                />
              </div>
            )}

            {step === STEP_COPY && (
              <div className="flex flex-col gap-4">
                <p className="text-ui text-muted-foreground">
                  {t("codexDeviceLogin.copyCode.body")}
                </p>
                {userCode ? (
                  <button
                    type="button"
                    onClick={copyCode}
                    aria-label={copied ? t("codexDeviceLogin.copied") : t("codexDeviceLogin.copy")}
                    className="group flex w-full items-center justify-between gap-3 rounded-8 border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="font-mono text-title text-foreground">{userCode}</span>
                    {copied ? (
                      <span className="flex items-center gap-2 text-ui text-success-fg">
                        <Check className="h-4 w-4 shrink-0" aria-hidden />
                        {t("codexDeviceLogin.copied")}
                      </span>
                    ) : (
                      <span className="flex items-center gap-2 text-ui text-muted-foreground transition-colors group-hover:text-primary">
                        <Copy className="h-4 w-4 shrink-0" aria-hidden />
                        {t("codexDeviceLogin.copy")}
                      </span>
                    )}
                  </button>
                ) : (
                  <div className="flex items-center gap-2 rounded-8 border border-border px-4 py-3 text-ui text-muted-foreground">
                    <Spinner label={t("codexDeviceLogin.preparing")} />
                    <span aria-hidden>{t("codexDeviceLogin.preparing")}</span>
                  </div>
                )}
              </div>
            )}
          </DialogBody>

          <DialogFooter className="flex items-center justify-end gap-2">
            {step === STEP_ENABLE ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => window.open(CHATGPT_SECURITY_URL, "_blank", "noopener")}
                >
                  {t("codexDeviceLogin.enable.openSettings")}
                  <ExternalLink className="h-4 w-4" aria-hidden />
                </Button>
                <Button onClick={() => setStep(STEP_COPY)}>
                  {t("codexDeviceLogin.enable.confirm")}
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" className="mr-auto" onClick={() => setStep(STEP_ENABLE)}>
                  <ArrowLeft className="h-4 w-4" aria-hidden />
                  {t("codexDeviceLogin.back")}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleRetry}
                  disabled={starting}
                  aria-label={starting ? t("codexDeviceLogin.retrying") : undefined}
                >
                  {starting ? (
                    <Spinner label={t("codexDeviceLogin.retrying")} />
                  ) : (
                    <>
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      {t("codexDeviceLogin.retry")}
                    </>
                  )}
                </Button>
                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      {/* Span wrapper so the tooltip still fires while the button
                          is disabled (disabled buttons emit no pointer events). */}
                      <span tabIndex={hasCopied ? undefined : 0}>
                        <Button
                          onClick={() =>
                            verificationUrl && window.open(verificationUrl, "_blank", "noopener")
                          }
                          disabled={!verificationUrl || !hasCopied}
                        >
                          {t("codexDeviceLogin.openButton")}
                          <ExternalLink className="h-4 w-4" aria-hidden />
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!hasCopied && (
                      <TooltipContent>{t("codexDeviceLogin.copyFirst")}</TooltipContent>
                    )}
                  </Tooltip>
                </TooltipProvider>
              </>
            )}
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
