import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { z } from "zod";
import { AuthActionButton, AuthError, AuthScreen } from "@/components/auth-screen";
import { Button } from "@/components/ui/button";
import { CloudLoginButton, cloudErrorReasonKey } from "@/components/cloud-login-button";
import { Field, FieldError, FieldGroup, FieldLabel, FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { AUTH_QUERY_KEY, useAuthStateSnapshot } from "@/lib/auth-state";
import { takeLoginReturn } from "@/lib/login-return";
import { beginDashboardVisitorLogin, visitorErrorReasonKey } from "@/lib/visitor-login";

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
  const [searchParams, setSearchParams] = useSearchParams();
  const { hash } = useLocation();
  const { bootstrap } = useAuthStateSnapshot();
  const [serverError, setServerError] = useState("");
  const [cloudError, setCloudError] = useState("");
  const [visitorError, setVisitorError] = useState("");
  const [visitorStarting, setVisitorStarting] = useState(false);

  // The sign-in view is driven entirely by the bootstrap state's
  // needs-signin arm. Cloud-primary boxes show the cloud button; the local
  // password form is the fallback (offline / Rome Cloud unreachable), swapped in
  // by a link — and that link only appears when a real local password actually
  // exists (`localPasswordAvailable`). Local-first boxes show the form outright.
  // Either way one method shows at a time, so the page has one primary action.
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

  // Rome Cloud's "Open your Rome" links land here with `?via=cloud`: the owner
  // arrives signed in to Rome Cloud, which approves the owner without a
  // consent screen, so the sign-in starts without waiting for the click. The
  // hint is read once and dropped from the URL, so Back never restarts it. A
  // failed attempt returns as `?cloud=error`, which shows the button instead.
  const [cloudHint] = useState(() => searchParams.get("via") === "cloud");
  const autoStartCloud = cloudHint && !cloudError && !cloudCallbackError && !visitorCallbackError;
  useEffect(() => {
    if (!searchParams.has("via")) return;
    const next = new URLSearchParams(searchParams);
    next.delete("via");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
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

        await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
        navigate(takeLoginReturn());
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

  const passwordForm = (
    <form
      noValidate
      className="w-full text-left"
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
            const invalid = field.state.meta.isTouched && field.state.meta.errors.length > 0;
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
            <Button type="submit" size="md" disabled={isSubmitting} className="w-full touch-target">
              {isSubmitting ? t("login.submitting") : t("login.submit")}
            </Button>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  );

  // The quiet link that swaps between the cloud button and the password form.
  const switchMethod = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="mt-4 text-ui text-muted-foreground hover:text-foreground focus:outline-none focus-visible:underline"
    >
      {label}
    </button>
  );

  let body: ReactNode;
  if (cloudPrimary) {
    // One Rome Cloud button for guardian and invited emails alike — the cloud
    // callback dispatches a non-owner into the visitor flow. The password form
    // swaps in by hiding the cloud block, not unmounting it: a start still in
    // flight keeps its busy state and auto-start guard, so swapping back can
    // never begin a second attempt that overwrites the first one's state cookie.
    body = (
      <>
        <div hidden={showLocalForm} className="w-full">
          <CloudLoginButton onStartError={setCloudError} autoStart={autoStartCloud} />
          {cloudErrorMessage && <AuthError>{cloudErrorMessage}</AuthError>}
          {localPasswordAvailable &&
            switchMethod(t("login.useLocalPassword"), () => setShowLocalForm(true))}
        </div>
        {showLocalForm && (
          <>
            {passwordForm}
            {switchMethod(t("login.useCloud"), () => setShowLocalForm(false))}
          </>
        )}
      </>
    );
  } else {
    body = (
      <>
        {passwordForm}
        {/* The explicit visitor button survives only for the local-method arm,
            which has no cloud button to dispatch from. */}
        {dashboardVisitorAccess && (
          <>
            <AuthActionButton
              variant="outline"
              className="mt-3"
              busy={visitorStarting}
              busyLabel={t("visitorDashboard.connecting")}
              onClick={() => void startDashboardVisitorLogin()}
            >
              {t("visitorDashboard.signIn")}
            </AuthActionButton>
            {visitorErrorMessage && <AuthError>{visitorErrorMessage}</AuthError>}
          </>
        )}
      </>
    );
  }

  return (
    <AuthScreen title={t("login.title")}>
      {body}
      {showGoogleOAuth && (
        <Button asChild variant="outline" size="md" className="mt-3 w-full touch-target">
          <a href="/api/oauth/google/start?intent=sign-in">{t("login.google")}</a>
        </Button>
      )}
    </AuthScreen>
  );
}
