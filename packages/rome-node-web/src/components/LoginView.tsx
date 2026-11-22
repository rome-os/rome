import { useState, type FormEvent, type ReactNode } from "react";
import { KeyRound, Languages, ShieldCheck } from "lucide-react";
import { Button } from "@rome-os/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rome-os/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel, FormError } from "@rome-os/ui/field";
import { IconButton } from "@rome-os/ui/icon-button";
import { Input } from "@rome-os/ui/input";
import { Spinner } from "@rome-os/ui/spinner";
import { api } from "../api";
import type { Messages } from "../i18n";
import type { AuthSession, PasswordSource } from "../types";
import { RomeLogo } from "./RomeLogo";

export interface LoginViewProps {
  t: Messages;
  passwordSource: PasswordSource;
  themeIcon: ReactNode;
  themeLabel: string;
  onCycleTheme: () => void;
  onToggleLocale: () => void;
  onUnlocked: (session: AuthSession) => void;
}

export function LoginView({
  t,
  passwordSource,
  themeIcon,
  themeLabel,
  onCycleTheme,
  onToggleLocale,
  onUnlocked,
}: LoginViewProps) {
  const [setupToken, setSetupToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSetup = passwordSource === "setup";

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isSetup) {
      if (!setupToken.trim()) {
        setError(t.login.setupTokenEmpty);
        return;
      }
      if (password.length < 6 || password.trim().length === 0) {
        setError(t.password.tooShort);
        return;
      }
      if (password !== confirmPassword) {
        setError(t.password.mismatch);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const nextSession = await api.setup({ token: setupToken.trim(), newPassword: password });
        setSetupToken("");
        setPassword("");
        setConfirmPassword("");
        onUnlocked(nextSession);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!password) {
      setError(t.login.empty);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const nextSession = await api.login(password);
      setPassword("");
      onUnlocked(nextSession);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

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
            <CardTitle>{isSetup ? t.login.setupTitle : t.login.title}</CardTitle>
            <CardDescription>
              {isSetup ? t.login.setupDescription : t.login.description}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {isSetup ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="rome-node-setup-token">
                      {t.login.setupTokenLabel}
                    </FieldLabel>
                    <Input
                      id="rome-node-setup-token"
                      type="password"
                      autoComplete="one-time-code"
                      autoFocus
                      size="md"
                      icon={<ShieldCheck />}
                      placeholder={t.login.setupTokenPlaceholder}
                      value={setupToken}
                      onChange={(e) => setSetupToken(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="rome-node-setup-password">
                      {t.password.newLabel}
                    </FieldLabel>
                    <Input
                      id="rome-node-setup-password"
                      type="password"
                      autoComplete="new-password"
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
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
