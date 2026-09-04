import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff } from "lucide-react";
import { z } from "zod";

import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AUTH_QUERY_KEY, useAuthStateSnapshot } from "@/lib/auth-state";

// Local-first setup, and the whole of it: the username and password that lock
// this Rome to its guardian. Creating the account also finishes setup
// server-side (the username becomes the display name, the agent gets a preset
// identity), so the guardian name and the agent name are confirmed in the
// welcome conversation rather than asked for twice. A cloud box never reaches
// this page — its sign-in callback creates the seat and finishes setup.
export default function OnboardPage() {
  const { t } = useTranslation("onboard");
  const { bootstrap } = useAuthStateSnapshot();
  const queryClient = useQueryClient();

  // Repair path for an instance that was signed in but mid-onboarding when this
  // version landed: there is no profile step left to finish, so mark setup
  // complete and let the gate route on. Without this the phase would hold at
  // `needs-onboarding` against a page that only creates accounts.
  const stranded = bootstrap?.phase === "needs-onboarding";
  useEffect(() => {
    if (!stranded) return;
    void (async () => {
      await fetch("/api/onboard/complete", { method: "POST", credentials: "include" }).catch(
        () => {},
      );
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
    })();
  }, [stranded, queryClient]);

  if (stranded) return null;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-muted px-4 pb-[calc(3rem+var(--rome-safe-area-bottom))] pt-[calc(3rem+var(--rome-safe-area-top))]">
      <div className="w-full max-w-xl">
        <div className="mb-2 flex items-center justify-center gap-2 text-foreground">
          <RomeLogo className="h-7 w-7" aria-hidden />
          <h1 className="text-title">{t("page.title")}</h1>
        </div>
        <p className="mb-7 text-center text-body text-muted-foreground">{t("account.tagline")}</p>
        <div className="rounded-12 border border-border bg-surface p-6 shadow-1 sm:p-8">
          <AccountStep />
        </div>
      </div>
    </main>
  );
}

function AccountStep() {
  const { t } = useTranslation("onboard");
  const queryClient = useQueryClient();
  const [serverError, setServerError] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const schema = z.object({
    userId: z.string().trim().min(1, t("account.errorUsernameRequired")),
    password: z.string().min(8, t("account.errorPasswordTooShort")),
  });

  const form = useForm({
    defaultValues: { userId: "", password: "" },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      setServerError("");
      try {
        const response = await fetch("/api/onboard/create-account", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ userId: value.userId, password: value.password }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          setServerError(data.error || t("account.errorFallback"));
          return;
        }

        // Setup is complete server-side, so refreshing the auth state flips the
        // phase to `ready` and AuthGate redirects to the welcome app. Navigating
        // here too would race that redirect.
        await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      } catch {
        setServerError(t("account.networkError"));
      }
    },
  });

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <FieldGroup>
        <form.Field name="userId">
          {(field) => {
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
            return (
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={field.name}>{t("account.username")}</FieldLabel>
                <Input
                  id={field.name}
                  name={field.name}
                  type="text"
                  autoComplete="username"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  onBlur={field.handleBlur}
                  aria-invalid={invalid || undefined}
                  aria-describedby={invalid ? `${field.name}-error` : undefined}
                />
                <FieldError
                  id={`${field.name}-error`}
                  errors={invalid ? field.state.meta.errors : undefined}
                />
              </Field>
            );
          }}
        </form.Field>

        <form.Field name="password">
          {(field) => {
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
            const hintId = `${field.name}-hint`;
            const errorId = `${field.name}-error`;
            return (
              <Field data-invalid={invalid || undefined}>
                <FieldLabel htmlFor={field.name}>{t("account.password")}</FieldLabel>
                <div className="relative">
                  <Input
                    id={field.name}
                    name={field.name}
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    onBlur={field.handleBlur}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? errorId : hintId}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={
                      showPassword ? t("account.hidePassword") : t("account.showPassword")
                    }
                    aria-pressed={showPassword}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-subtle-foreground transition-colors hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:ring-offset-0 rounded-8"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" aria-hidden />
                    ) : (
                      <Eye className="h-4 w-4" aria-hidden />
                    )}
                  </button>
                </div>
                {invalid ? (
                  <FieldError id={errorId} errors={field.state.meta.errors} />
                ) : (
                  <p id={hintId} className="text-aux text-subtle-foreground">
                    {t("account.passwordHint")}
                  </p>
                )}
              </Field>
            );
          }}
        </form.Field>

        {serverError && <FormError>{serverError}</FormError>}

        <form.Subscribe<boolean> selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button type="submit" size="md" disabled={isSubmitting} className="w-full touch-target">
              {isSubmitting ? t("account.submitting") : t("account.submit")}
            </Button>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  );
}
