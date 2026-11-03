import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowRight, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
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

const VNC_URL = "/desktop-vnc.html?resize=scale&path=desktop-proxy/websockify";
const STATUS_POLL_INTERVAL_MS = 2000;

type Step = "login" | "authorize";

interface ChatGPTLoginModalProps {
  open: boolean;
  onClose: () => void;
  onConnected: () => void;
}

interface AiToolsStatus {
  codex?: { loggedIn?: boolean };
  codexLogin?: {
    running?: boolean;
    lastExit?: { code: number | null; signal: string | null } | null;
    lastError?: string | null;
  };
}

export function ChatGPTLoginModal({ open, onClose, onConnected }: ChatGPTLoginModalProps) {
  const { t } = useTranslation("onboard");
  const [step, setStep] = useState<Step>("login");
  const [navReady, setNavReady] = useState(false);
  const [navTick, setNavTick] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingTransition, setPendingTransition] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const codexStartedRef = useRef(false);
  const completedRef = useRef(false);

  // Keep callback refs stable so the polling effect doesn't tear down on every
  // parent re-render (the parent passes inline lambdas).
  const onConnectedRef = useRef(onConnected);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onConnectedRef.current = onConnected;
    onCloseRef.current = onClose;
  }, [onConnected, onClose]);

  // Reset every time the modal opens.
  useEffect(() => {
    if (!open) return;
    setStep("login");
    setNavReady(false);
    setNavTick(0);
    setError(null);
    setPendingTransition(false);
    setRetrying(false);
    codexStartedRef.current = false;
    completedRef.current = false;
  }, [open]);

  // Step 1 — when the modal opens (or user goes back), navigate the server-side
  // Chrome to ChatGPT. `navTick` lets us re-run on demand without changing
  // structural deps.
  useEffect(() => {
    if (!open || step !== "login") return;
    let cancelled = false;
    setNavReady(false);
    (async () => {
      try {
        const res = await fetch("/api/desktop/navigate-chatgpt", {
          method: "POST",
        });
        if (cancelled) return;
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string };
          setError(data.error || t("chatgptLogin.errors.navigateFailed"));
          return;
        }
        setNavReady(true);
      } catch {
        if (!cancelled) setError(t("chatgptLogin.errors.navigateFailed"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, step, navTick, t]);

  const startCodexLogin = useCallback(async () => {
    setPendingTransition(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-tools/codex/login/start", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || t("chatgptLogin.errors.codexStartFailed"));
        setPendingTransition(false);
        return;
      }
      codexStartedRef.current = true;
      setStep("authorize");
    } catch {
      setError(t("chatgptLogin.errors.codexStartFailed"));
    } finally {
      setPendingTransition(false);
    }
  }, [t]);

  // Step 2 — poll AI status until codex reports loggedIn. We no longer surface a
  // "waiting" spinner; the user drives the flow with Retry/Back buttons, but we
  // still need to fire onConnected the moment codex finishes.
  // Deliberately leaves callbacks out of deps (we read them through refs) so
  // the effect doesn't tear down + immediately re-fire on every parent render.
  useEffect(() => {
    if (!open || step !== "authorize") return;
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
          // Tidy up any ChatGPT/OpenAI tabs we opened during the flow before
          // handing control back to the parent.
          fetch("/api/desktop/close-auth-tabs", { method: "POST" }).catch(() => {});
          onConnectedRef.current();
          return;
        }
        if (data.codexLogin?.lastError) {
          codexStartedRef.current = false;
          setError(data.codexLogin.lastError);
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
  }, [open, step]);

  const cancelCodexLogin = useCallback(() => {
    if (!codexStartedRef.current) return;
    fetch("/api/ai-tools/codex/login/cancel", { method: "POST" }).catch(() => {});
    codexStartedRef.current = false;
  }, []);

  const closeAuthTabs = useCallback(() => {
    fetch("/api/desktop/close-auth-tabs", { method: "POST" }).catch(() => {});
  }, []);

  const handleClose = useCallback(() => {
    cancelCodexLogin();
    closeAuthTabs();
    onClose();
  }, [cancelCodexLogin, closeAuthTabs, onClose]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-tools/codex/login/start", { method: "POST" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || t("chatgptLogin.errors.codexStartFailed"));
        return;
      }
      codexStartedRef.current = true;
      setError(null);
    } catch {
      setError(t("chatgptLogin.errors.codexStartFailed"));
    } finally {
      setRetrying(false);
    }
  }, [t]);

  const handleBack = useCallback(() => {
    cancelCodexLogin();
    setError(null);
    setStep("login");
    setNavTick((n) => n + 1);
  }, [cancelCodexLogin]);

  const stepIndex = step === "login" ? 1 : 2;
  const stepTitle =
    step === "login"
      ? t("chatgptLogin.steps.login.title")
      : t("chatgptLogin.steps.authorize.title");

  const noticeTitle =
    step === "login"
      ? t("chatgptLogin.steps.login.notice.title")
      : t("chatgptLogin.steps.authorize.notice.title");
  const noticeBody =
    step === "login"
      ? t("chatgptLogin.steps.login.notice.body")
      : t("chatgptLogin.steps.authorize.notice.body");

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      ariaLabel={t("chatgptLogin.title")}
      modal
      className="flex h-[88vh] w-[min(96vw,1200px)] max-w-none flex-col p-0"
    >
      <DialogHeader onClose={handleClose} closeLabel={t("chatgptLogin.cancel")}>
        <div className="flex flex-col gap-1">
          <DialogTitle>{t("chatgptLogin.title")}</DialogTitle>
          <p className="text-aux text-muted-foreground">
            {t("chatgptLogin.stepIndicator", { current: stepIndex, total: 2 })} · {stepTitle}
          </p>
        </div>
      </DialogHeader>

      <DialogBody className="flex max-h-none min-h-0 flex-1 flex-col gap-3 px-3 py-3">
        <Alert variant="success" className="shrink-0">
          <Sparkles aria-hidden />
          <AlertTitle>{noticeTitle}</AlertTitle>
          <AlertDescription>{noticeBody}</AlertDescription>
        </Alert>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
          <div className="relative aspect-[8/5] h-full max-h-full w-auto max-w-full overflow-hidden rounded-12 border border-border bg-surface-muted">
            {!navReady && !error && step === "login" && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/95">
                <div className="flex items-center gap-2 text-ui text-muted-foreground">
                  <Spinner label={t("chatgptLogin.preparingBrowser")} />
                  <span aria-hidden>{t("chatgptLogin.preparingBrowser")}</span>
                </div>
              </div>
            )}
            {error && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface/95 px-6 text-center">
                <p className="text-ui text-destructive-fg">{error}</p>
              </div>
            )}
            <iframe
              title={t("chatgptLogin.iframeTitle")}
              src={VNC_URL}
              className="block h-full w-full border-0"
              allow="clipboard-read; clipboard-write"
            />
          </div>
        </div>

        <p className="flex shrink-0 items-center gap-2 text-aux text-subtle-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t("chatgptLogin.privacyNote")}</span>
        </p>
      </DialogBody>

      <DialogFooter className="flex items-center justify-end gap-3">
        {step === "login" ? (
          <Button
            size="md"
            className="touch-target"
            onClick={startCodexLogin}
            disabled={!navReady || pendingTransition}
            aria-label={pendingTransition ? t("chatgptLogin.starting") : undefined}
          >
            {pendingTransition ? (
              <Spinner label={t("chatgptLogin.starting")} />
            ) : (
              <>
                {t("chatgptLogin.steps.login.cta")}
                <ArrowRight data-icon="inline-end" className="h-4 w-4" aria-hidden />
              </>
            )}
          </Button>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              size="md"
              variant="outline"
              className="touch-target"
              onClick={handleBack}
              disabled={retrying}
            >
              <ArrowLeft data-icon="inline-start" className="h-4 w-4" aria-hidden />
              {t("chatgptLogin.steps.authorize.back")}
            </Button>
            <Button
              size="md"
              className="touch-target"
              onClick={handleRetry}
              disabled={retrying}
              aria-label={retrying ? t("chatgptLogin.retrying") : undefined}
            >
              {retrying ? (
                <Spinner label={t("chatgptLogin.retrying")} />
              ) : (
                <>
                  <RotateCcw data-icon="inline-start" className="h-4 w-4" aria-hidden />
                  {t("chatgptLogin.steps.authorize.retry")}
                </>
              )}
            </Button>
          </div>
        )}
      </DialogFooter>
    </Dialog>
  );
}
