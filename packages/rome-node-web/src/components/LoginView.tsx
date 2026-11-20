import { useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@rome-os/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@rome-os/ui/card";
import { Field, FieldLabel, FormError } from "@rome-os/ui/field";
import { Input } from "@rome-os/ui/input";
import { Spinner } from "@rome-os/ui/spinner";
import { api } from "../api";
import type { Messages } from "../i18n";
import type { AuthSession } from "../types";
import { RomeLogo } from "./RomeLogo";

export interface LoginViewProps {
  t: Messages;
  onUnlocked: (session: AuthSession) => void;
}

export function LoginView({ t, onUnlocked }: LoginViewProps) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
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
    <main className="flex min-h-screen w-full items-center justify-center bg-background p-4 sm:p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="flex items-center justify-center gap-3 text-foreground">
          <RomeLogo className="size-8" />
          <span className="text-title">{t.appTitle}</span>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>{t.login.title}</CardTitle>
            <CardDescription>{t.login.description}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
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
              {error ? <FormError>{error}</FormError> : null}
              <Button type="submit" size="md" className="w-full" disabled={busy}>
                {busy ? <Spinner size="sm" data-icon="inline-start" /> : null}
                {busy ? t.login.submitting : t.login.submit}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
