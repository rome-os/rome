import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, Languages } from "lucide-react";
import { Button } from "@rome-os/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rome-os/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel, FormError } from "@rome-os/ui/field";
import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import { Spinner } from "@rome-os/ui/spinner";
import { api, ApiError } from "../api";
import type { Messages } from "../i18n";
import type { AuthSession, AuthSetupWindow, PasswordSource } from "../types";
import { RomeLogo } from "./RomeLogo";

export interface LoginViewProps {
  t: Messages;
  passwordSource: PasswordSource;
  setup?: AuthSetupWindow;
  themeIcon: ReactNode;
  themeLabel: string;
  onCycleTheme: () => void;
  onToggleLocale: () => void;
  onUnlocked: (session: AuthSession) => void;
  onRefreshSession: () => Promise<void> | void;
}

export function LoginView({
  t,
  passwordSource,
  setup,
  themeIcon,
  themeLabel,
  onCycleTheme,
  onToggleLocale,
  onUnlocked,
  onRefreshSession,
}: LoginViewProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(setup?.remainingMs);
  const [rejectedWindow, setRejectedWindow] = useState<AuthSetupWindow | null | undefined>(null);
  const isSetup = passwordSource === "setup";
  const expired =
    isSetup && (setup?.expired === true || remainingMs === 0 || rejectedWindow === setup);

  const refreshSession = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await onRefreshSession();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [onRefreshSession]);

  useEffect(() => {
    if (!isSetup || !setup || setup.expired || rejectedWindow === setup) return;
    const deadline = Date.now() + setup.remainingMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function tick() {
      const remaining = Math.max(0, deadline - Date.now());
      setRemainingMs(remaining);
      if (remaining > 0) timer = setTimeout(tick, Math.min(1000, remaining));
      return remaining;
    }
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      if (tick() === 0) {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        void refreshSession();
      }
    }
    tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [isSetup, setup, rejectedWindow, refreshSession]);

  useEffect(() => {
    setError(null);
    if (expired) {
      setPassword("");
      setConfirmPassword("");
    }
  }, [expired, passwordSource]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || expired) return;
    if (isSetup) {
      if (password.length < 6 || password.trim().length === 0) {
        setError(t.password.tooShort);
        return;
      }
      if (password !== confirmPassword) {
        setError(t.password.mismatch);
        return;
      }
    } else if (!password) {
      setError(t.login.empty);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextSession = await (isSetup ? api.setup(password) : api.login(password));
      setPassword("");
      setConfirmPassword("");
      onUnlocked(nextSession);
    } catch (err) {
      if (isSetup && err instanceof ApiError) {
        if (err.status === 410 || err.code === "setup_expired") {
          setRejectedWindow(setup);
          return;
        }
        if (err.status === 409 || err.code === "setup_conflict") {
          setPassword("");
          setConfirmPassword("");
          await refreshSession();
          return;
        }
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const remainingSeconds = Math.ceil((remainingMs ?? 0) / 1000);
  const countdown = `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;

  return (
    <main className="relative flex min-h-screen w-full items-center justify-center bg-background p-4 sm:p-6">
      <div className="absolute right-4 top-4 flex items-center gap-1 sm:right-6 sm:top-6">
        <IconButton label={themeLabel} size="sm" onClick={onCycleTheme} icon={themeIcon} />
        <IconButton
          label={t.header.switchLanguage}
          size="sm"
          onClick={onToggleLocale}
          icon={<Languages />}
        />
      </div>
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-1 text-foreground">
          <div className="flex items-center justify-center gap-2.5">
            <RomeLogo className="size-8" />
            <span className="text-title">{t.brandName}</span>
          </div>
          <span className="text-sm text-muted-foreground">{t.toolName}</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>
              {expired ? t.login.setupExpiredTitle : isSetup ? t.login.setupTitle : t.login.title}
            </CardTitle>
            <CardDescription>
              {expired
                ? t.login.setupExpiredDescription
                : isSetup
                  ? t.login.setupDescription
                  : t.login.description}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {expired ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">{t.login.setupRecovery}</p>
                {error ? <FormError>{error}</FormError> : null}
                <Button size="md" className="w-full" disabled={busy} onClick={refreshSession}>
                  {busy ? <Spinner size="sm" data-icon="inline-start" /> : null}
                  {t.login.setupRefresh}
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {isSetup ? (
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="rome-node-setup-password">
                        {t.password.newLabel}
                      </FieldLabel>
                      <Input
                        id="rome-node-setup-password"
                        type="password"
                        autoComplete="new-password"
                        autoFocus
                        size="md"
                        icon={<KeyRound />}
                        placeholder={t.login.passwordPlaceholder}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        disabled={busy}
                      />
                      <FieldDescription>{t.password.minLengthHint}</FieldDescription>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="rome-node-setup-confirm">
                        {t.password.confirmLabel}
                      </FieldLabel>
                      <Input
                        id="rome-node-setup-confirm"
                        type="password"
                        autoComplete="new-password"
                        size="md"
                        icon={<KeyRound />}
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        disabled={busy}
                      />
                    </Field>
                  </FieldGroup>
                ) : (
                  <Field>
                    <FieldLabel htmlFor="rome-node-ui-password">{t.login.passwordLabel}</FieldLabel>
                    <Input
                      id="rome-node-ui-password"
                      type="password"
                      autoComplete="current-password"
                      autoFocus
                      size="md"
                      icon={<KeyRound />}
                      placeholder={t.login.passwordPlaceholder}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                )}
                {isSetup && remainingMs !== undefined ? (
                  <p role="timer" className="text-sm text-muted-foreground tabular-nums">
                    {t.login.setupRemaining(countdown)}
                  </p>
                ) : null}
                {error ? <FormError>{error}</FormError> : null}
                <Button type="submit" size="md" className="w-full" disabled={busy}>
                  {busy ? <Spinner size="sm" data-icon="inline-start" /> : null}
                  {busy
                    ? isSetup
                      ? t.login.setupSubmitting
                      : t.login.submitting
                    : isSetup
                      ? t.login.setupSubmit
                      : t.login.submit}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
