"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Check, ExternalLink } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Dialog, DialogHeader, DialogTitle, DialogBody } from "@/components/ui/dialog";

type Status = "connecting" | "connected" | "error";

interface TerminalModalProps {
  preset: string;
  onClose: () => void;
}

interface AIToolStatus {
  loggedIn: boolean;
}

const POLL_INTERVAL_MS = 2000;
// How long the success checkmark lingers before the dialog closes itself.
const SUCCESS_EXIT_DELAY_MS = 1200;
const CONNECT_TIMEOUT_MS = 30000;
// If the sign-in URL never arrives after connecting, surface an error instead
// of spinning forever. It normally appears within a few seconds.
const PREPARE_TIMEOUT_MS = 25000;

function getTerminalWebSocketUrl(preset: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL("/ws/terminal", `${protocol}//${window.location.host}`);
  url.searchParams.set("preset", preset);
  return url.toString();
}

/**
 * Native dialog for the PTY-backed Claude login flow. The terminal itself is
 * never shown: the modal opens the WebSocket that runs `claude /login`, shows
 * instructions with a button to open the parsed sign-in page, and takes the
 * pasted callback link or code. Completion is detected by polling
 * `/api/ai-tools/status`. (Logout is non-interactive and handled inline on the
 * Settings button, so it never opens this dialog.)
 */
export default function TerminalModal({ preset, onClose }: TerminalModalProps) {
  const { t } = useTranslation("common");
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [authComplete, setAuthComplete] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [codeSubmitted, setCodeSubmitted] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  const isLogin = preset.endsWith("-login");
  const providerKey = preset.replace(/-login$/, "");

  // One auth-status probe; flips authComplete when the desired state is reached.
  // Reused by the poll and by the PTY-exit handler — the process can exit the
  // instant login persists, before the next poll tick, so we re-check on exit.
  //
  // Re-probes via POST /ai-tools/claude/auth-check rather than reading GET
  // /ai-tools/status. The cached status only refreshes when the PTY process
  // exits or on the hourly timer, but `claude /login` on CLI 2.1.251 does not
  // exit after a successful login (it drops into the interactive session), so a
  // cached read would keep the dialog spinning on a login that already
  // succeeded. This endpoint runs only the live Claude auth probe — not usage or
  // Codex — so an unrelated slow probe can never stall login detection. It
  // returns the same provider-keyed shape as the status endpoint.
  const checkAuthOnce = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch("/api/ai-tools/claude/auth-check", { method: "POST", signal });
        const data = await res.json();
        const toolStatus = data[providerKey] as AIToolStatus | undefined;
        if (toolStatus?.loggedIn === true) setAuthComplete(true);
      } catch {
        /* ignore fetch errors */
      }
    },
    [providerKey],
  );

  // Poll auth status while the session is live. Each tick is scheduled only
  // after the previous probe settles, so a slow probe cannot pile requests up.
  useEffect(() => {
    if (status !== "connected") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = async () => {
      await checkAuthOnce(controller.signal);
      if (!cancelled) timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [status, checkAuthOnce]);

  // Once login lands, hold the checkmark briefly so it reads as a deliberate
  // success beat, then close. No countdown text — the morphing button is the cue.
  useEffect(() => {
    if (!authComplete) return;
    const timer = setTimeout(onClose, SUCCESS_EXIT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [authComplete, onClose]);

  // Fail-open: if the sign-in URL never arrives, show an error rather than
  // spinning forever (CLI reword, an unexpected prompt the watcher can't parse).
  useEffect(() => {
    if (status !== "connected" || !isLogin || authUrl || authComplete) return;
    const timer = setTimeout(() => {
      setStatus("error");
      setErrorMsg(t("terminal.errors.prepareTimeout"));
    }, PREPARE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, isLogin, authUrl, authComplete, t]);

  // WebSocket that runs the PTY command. We never render its raw output — only
  // the structured events the login watcher emits.
  useEffect(() => {
    const ws = new WebSocket(getTerminalWebSocketUrl(preset));
    wsRef.current = ws;
    let settled = false;
    // Guards against React StrictMode's mount→unmount→remount: the first WS is
    // torn down by the cleanup below, and its async `onclose` must NOT report a
    // spurious "connection closed" error over the live second connection.
    let disposed = false;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.CONNECTING) return;
      settled = true;
      setStatus("error");
      setErrorMsg(t("terminal.errors.connectTimeout"));
      ws.close();
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      if (disposed) return;
      setStatus("connected");
    };

    ws.onmessage = (event) => {
      if (disposed) return;
      let msg: { type?: string; url?: string; message?: string };
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "auth_url" && typeof msg.url === "string") {
        // We don't open the page automatically — the user opens it from the
        // dialog after reading the instructions.
        setAuthUrl(msg.url);
      } else if (msg.type === "auth_error" && typeof msg.message === "string") {
        // CLI rejected the pasted code; re-open the box with the error shown.
        setCodeError(msg.message);
        setCodeSubmitted(false);
      } else if (msg.type === "exit") {
        settled = true;
        // The process can exit the instant login persists; re-check now so a
        // success that lands between poll ticks still closes the dialog.
        if (isLogin) void checkAuthOnce();
      } else if (msg.type === "error") {
        settled = true;
        setStatus("error");
        setErrorMsg(typeof msg.message === "string" ? msg.message : null);
      }
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
      if (disposed || settled) return;
      setStatus("error");
      setErrorMsg(t("terminal.errors.websocketFailed"));
    };

    ws.onclose = (event) => {
      clearTimeout(connectTimeout);
      if (disposed || settled || authComplete) return;
      setStatus("error");
      setErrorMsg(event.reason || t("terminal.errors.closedUnexpectedly"));
    };

    return () => {
      disposed = true;
      clearTimeout(connectTimeout);
      ws.close();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, sessionKey]);

  // Open the sign-in page in a new tab. A click is a user gesture, so this is
  // never popup-blocked.
  const openSignIn = useCallback(() => {
    if (!authUrl) return;
    window.open(authUrl, "_blank", "noopener,noreferrer");
  }, [authUrl]);

  const handleReconnect = useCallback(() => {
    setStatus("connecting");
    setErrorMsg(null);
    setAuthComplete(false);
    setAuthUrl(null);
    setCodeInput("");
    setCodeSubmitted(false);
    setCodeError(null);
    setSessionKey((k) => k + 1);
  }, []);

  const submitCode = useCallback((raw: string) => {
    const code = raw.trim();
    if (!code) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "submit_code", code }));
      setCodeSubmitted(true);
      setCodeError(null);
    }
  }, []);

  const title = t("terminal.claudeLogin.title");

  return (
    <Dialog open onClose={onClose} size="md" ariaLabel={title}>
      <DialogHeader onClose={onClose} closeLabel={t("terminal.close")}>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>

      <DialogBody className="flex flex-col gap-4">
        {errorMsg ? (
          <div className="flex flex-col gap-3">
            <p className="text-ui text-destructive">{errorMsg}</p>
            <Button variant="outline" className="self-start" onClick={handleReconnect}>
              {t("terminal.reconnect")}
            </Button>
          </div>
        ) : isLogin ? (
          <>
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-body text-muted-foreground">
              <li>{t("terminal.claudeLogin.step1")}</li>
              <li>{t("terminal.claudeLogin.step2")}</li>
              <li>{t("terminal.claudeLogin.step3")}</li>
            </ol>
            {/* The button waits on the sign-in URL the PTY watcher parses out;
                the instructions above render instantly so the dialog never
                looks like it's loading. */}
            <Button
              className="self-start"
              onClick={openSignIn}
              disabled={!authUrl || authComplete}
              aria-label={!authUrl ? t("terminal.claudeLogin.preparingUrl") : undefined}
            >
              {authUrl ? (
                <ExternalLink />
              ) : (
                <Spinner label={t("terminal.claudeLogin.preparingUrl")} />
              )}
              {t("terminal.claudeLogin.openButton")}
            </Button>
            <div className="flex flex-col gap-2">
              <FieldLabel htmlFor="claude-login-code">
                {t("terminal.claudeLogin.codeLabel")}
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="claude-login-code"
                  value={codeInput}
                  onChange={(e) => {
                    setCodeInput(e.target.value);
                    setCodeError(null);
                  }}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text");
                    if (!pasted.trim()) return;
                    e.preventDefault();
                    setCodeInput(pasted);
                    setCodeError(null);
                    submitCode(pasted);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      submitCode(codeInput);
                    }
                  }}
                  placeholder={t("terminal.claudeLogin.codePlaceholder")}
                  aria-invalid={codeError !== null}
                  disabled={codeSubmitted || authComplete}
                  autoFocus
                />
                {/* The submit button is the success surface: text → spinner
                    (submitting) → checkmark (logged in), then the dialog closes
                    itself after SUCCESS_EXIT_DELAY_MS. */}
                <Button
                  onClick={() => submitCode(codeInput)}
                  disabled={authComplete || codeSubmitted || !codeInput.trim()}
                  aria-live="polite"
                  aria-label={codeSubmitted ? t("terminal.claudeLogin.submittingCode") : undefined}
                >
                  {authComplete ? (
                    <Check className="size-4 animate-widget-in" />
                  ) : codeSubmitted ? (
                    <Spinner label={t("terminal.claudeLogin.submittingCode")} />
                  ) : (
                    t("terminal.claudeLogin.submit")
                  )}
                </Button>
              </div>
              {codeError && <p className="text-ui text-destructive">{codeError}</p>}
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-ui text-muted-foreground">
            <Spinner label={t("terminal.claudeLogin.preparing")} />
            <span aria-hidden>{t("terminal.claudeLogin.preparing")}</span>
          </p>
        )}
      </DialogBody>
    </Dialog>
  );
}
