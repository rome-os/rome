import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CloudLoginButton, cloudErrorReasonKey } from "@/components/cloud-login-button";
import { Field, FieldError, FieldGroup, FieldLabel, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AUTH_QUERY_KEY, useAuthStateSnapshot } from "@/lib/auth-state";
import { beginDashboardVisitorLogin, visitorErrorReasonKey } from "@/lib/visitor-login";
import { DASHBOARD_IDENTITY_QUERY_KEY } from "@/hooks/use-dashboard-identity";

function envFlagEnabled(value: unknown): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

const showGoogleOAuth = envFlagEnabled(import.meta.env.SHOW_GOOGLE_OAUTH);

export default function LoginPage() {
  const { t } = useTranslation("auth");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const { hash } = useLocation();
  const { bootstrap } = useAuthStateSnapshot();
  const [serverError, setServerError] = useState("");
  const [cloudError, setCloudError] = useState("");
  const [visitorError, setVisitorError] = useState("");
  const [visitorStarting, setVisitorStarting] = useState(false);

  // The sign-in view is driven entirely by the bootstrap state's
  // needs-signin arm. Cloud-primary boxes show the cloud button; the local
  // password form is the fallback (offline / Rome Cloud unreachable), tucked behind
  // a link — and that link only appears when a real local password actually
  // exists (`localPasswordAvailable`). Local-first boxes show the form outright.
  const signin = bootstrap?.phase === "needs-signin" ? bootstrap : null;
  const cloudPrimary = signin?.method === "cloud";
  const localPasswordAvailable = signin?.method === "cloud" ? signin.localPasswordAvailable : true;
  const dashboardVisitorAccess = signin?.dashboardVisitorAccess === true;
  const [showLocalForm, setShowLocalForm] = useState(!cloudPrimary);

  // Both callbacks bounce failures back here — the cloud-login callback as
  // ?cloud=error&reason=… and the visitor callback (which the cloud flow
  // dispatches a non-owner into) as ?visitor=error&reason=…. One button, one
  // error slot: surface whichever arrived until the next attempt clears it.
  const cloudCallbackError =
    searchParams.get("cloud") === "error" ? t(cloudErrorReasonKey(searchParams.get("reason"))) : "";
  const rejectedEmail = new URLSearchParams(hash.slice(1)).get("email")?.trim();
  const visitorCallbackError =
    searchParams.get("visitor") === "error"
      ? searchParams.get("reason") === "forbidden" && rejectedEmail
        ? t("visitorDashboard.errorForbiddenAccount", { email: rejectedEmail })
        : t(visitorErrorReasonKey(searchParams.get("reason")))
      : "";
  const cloudErrorMessage = cloudError || cloudCallbackError || visitorCallbackError;
  const visitorErrorMessage = visitorError || visitorCallbackError;

  const schema = z.object({
    userId: z.string().min(1, t("login.errorUsernameRequired")),
    password: z.string().min(1, t("login.errorPasswordRequired")),
  });

  const form = useForm({
    defaultValues: { userId: "", password: "" },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      setServerError("");
      try {
        const res = await fetch("/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(value),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setServerError(data.error || t("login.errorFallback"));
          return;
        }

        // Discard an anonymous /api/auth/me request that may have started
        // before the login cookie changed, then force the active boundary to
        // fetch the authenticated identity.
        await queryClient.cancelQueries({ queryKey: DASHBOARD_IDENTITY_QUERY_KEY });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: DASHBOARD_IDENTITY_QUERY_KEY }),
        ]);
        navigate("/");
      } catch {
        setServerError(t("networkError"));
      }
    },
  });

  async function startDashboardVisitorLogin() {
    setVisitorStarting(true);
    setVisitorError("");
    const result = await beginDashboardVisitorLogin();
    if (!result.ok) {
      setVisitorError(
        result.reason === "network" ? t("networkError") : t("visitorDashboard.errorStart"),
      );
      setVisitorStarting(false);
    }
  }

  return (
    <main className="relative flex min-h-dvh items-center justify-center bg-surface-muted px-4 pb-safe pt-safe">
      <div className="absolute right-4 top-[calc(1rem+var(--rome-safe-area-top))]">
        <LanguageSwitcher />
      </div>
      <div className="w-full max-w-sm">
        <h1 className="mb-2 text-center text-title text-foreground">{t("login.title")}</h1>
        <p className="mb-8 text-center text-ui text-muted-foreground">
          {t(dashboardVisitorAccess ? "login.descriptionShared" : "login.description")}
        </p>

        <div className="rounded-12 border border-border bg-surface p-6 shadow-1 sm:p-8">
          {/* On a cloud-primary box there is one Rome Cloud button for guardian
              and invited emails alike — the cloud callback dispatches a
              non-owner into the visitor flow. This explicit visitor button
              survives only for the local-method arm, which has no cloud button
              to dispatch from. */}
          {!cloudPrimary && dashboardVisitorAccess && (
            <div className="mb-6">
              {visitorErrorMessage && (
                <Alert variant="destructive" className="mb-4">
                  <AlertDescription className="break-words">{visitorErrorMessage}</AlertDescription>
                </Alert>
              )}
              <Button
                type="button"
                size="md"
                variant="outline"
                className="w-full touch-target"
                disabled={visitorStarting}
                onClick={() => void startDashboardVisitorLogin()}
              >
                {visitorStarting ? t("visitorDashboard.connecting") : t("visitorDashboard.signIn")}
              </Button>
            </div>
          )}

          {!cloudPrimary && dashboardVisitorAccess && showLocalForm && (
            <div className="relative mb-6">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-surface px-3 text-aux text-muted-foreground">
                  {t("login.or")}
                </span>
              </div>
            </div>
          )}

          {cloudPrimary && (
            <div className="mb-6">
              {cloudErrorMessage && (
                <Alert variant="destructive" className="mb-4">
                  <AlertDescription className="break-words">{cloudErrorMessage}</AlertDescription>
                </Alert>
              )}
              <CloudLoginButton onStartError={setCloudError} />
              {localPasswordAvailable && !showLocalForm && (
                <button
                  type="button"
                  onClick={() => setShowLocalForm(true)}
                  className="mt-4 w-full text-center text-ui text-muted-foreground hover:text-foreground focus:outline-none focus:underline"
                >
                  {t("login.useLocalPassword")}
                </button>
              )}
            </div>
          )}

          {cloudPrimary && showLocalForm && (
            <div className="relative mb-6">
              <div className="absolute inset-0 flex items-center" aria-hidden="true">
                <div className="w-full border-t border-border" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-surface px-3 text-aux text-muted-foreground">
                  {t("login.or")}
                </span>
              </div>
            </div>
          )}

          {showLocalForm && (
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
                    const invalid =
                      field.state.meta.isTouched && field.state.meta.errors.length > 0;
                    return (
                      <Field data-invalid={invalid || undefined}>
                        <FieldLabel htmlFor={field.name}>{t("login.username")}</FieldLabel>
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
                    const invalid =
                      field.state.meta.isTouched && field.state.meta.errors.length > 0;
                    return (
                      <Field data-invalid={invalid || undefined}>
                        <FieldLabel htmlFor={field.name}>{t("login.password")}</FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          type="password"
                          autoComplete="current-password"
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

                {serverError && <FormError>{serverError}</FormError>}

                <form.Subscribe<boolean> selector={(state) => state.isSubmitting}>
                  {(isSubmitting) => (
                    <Button
                      type="submit"
                      size="md"
                      disabled={isSubmitting}
                      className="w-full touch-target"
                    >
                      {isSubmitting ? t("login.submitting") : t("login.submit")}
                    </Button>
                  )}
                </form.Subscribe>
              </FieldGroup>
            </form>
          )}

          {showGoogleOAuth && (
            <div className="mt-6">
              <div className="relative">
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center">
                  <span className="bg-surface px-3 text-aux text-muted-foreground">
                    {t("login.or")}
                  </span>
                </div>
              </div>
              <a
                href="/api/oauth/google/start"
                className="mt-4 flex w-full items-center justify-center rounded-8 border border-border-strong bg-surface px-4 py-2 text-ui text-foreground shadow-1 hover:bg-surface-muted focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              >
                {t("login.google")}
              </a>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
