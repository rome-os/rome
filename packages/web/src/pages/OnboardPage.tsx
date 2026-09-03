import { useEffect, useState } from "react";
import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Dices, Eye, EyeOff } from "lucide-react";
import { z } from "zod";

import { AiToolsPanel } from "@/components/ai-tools-panel";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FormError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Stepper } from "@/components/ui/stepper";
import { AUTH_QUERY_KEY, useAuthStateSnapshot } from "@/lib/auth-state";

const ONBOARDING_HIDDEN_AI_PROVIDERS = ["gemini", "grok"] as const;

interface AgentIdentity {
  name: string;
  purpose: string;
}

// The preset list lives in core and rides the draft response, so every setup
// path draws from the same names.
function pickPreset(presets: AgentIdentity[]): AgentIdentity | null {
  if (presets.length === 0) return null;
  return presets[Math.floor(Math.random() * presets.length)];
}

function readPresets(value: unknown): AgentIdentity[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((p) =>
    p &&
    typeof p === "object" &&
    typeof (p as AgentIdentity).name === "string" &&
    typeof (p as AgentIdentity).purpose === "string"
      ? [{ name: (p as AgentIdentity).name, purpose: (p as AgentIdentity).purpose }]
      : [],
  );
}

type Step = "account" | "profile";

function detectTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

export default function OnboardPage() {
  const { t } = useTranslation("onboard");
  // The bootstrap phase decides the first step. `needs-account`
  // (local-first, no seat yet) opens on the create-account step; everything else
  // is profile/agent/AI-tools only. A cloud box normally never lands here: the
  // sign-in callback finishes setup with defaults, and this page is only its
  // fallback when that write failed. Captured at mount so advancing past the
  // account step (which flips the backend phase to needs-onboarding) doesn't tear
  // down the stepper mid-flow.
  const { bootstrap } = useAuthStateSnapshot();
  const [startedAtAccount] = useState(() => bootstrap?.phase === "needs-account");
  const [step, setStep] = useState<Step>(startedAtAccount ? "account" : "profile");

  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface-muted px-4 pb-[calc(3rem+var(--rome-safe-area-bottom))] pt-[calc(3rem+var(--rome-safe-area-top))]">
      <div className="w-full max-w-xl">
        <div className="mb-2 flex items-center justify-center gap-2 text-foreground">
          <RomeLogo className="h-7 w-7" aria-hidden />
          <h1 className="text-title">{t("page.title")}</h1>
        </div>
        <p className="mb-7 text-center text-body text-muted-foreground">
          {step === "account" ? t("account.tagline") : t("page.tagline")}
        </p>

        {/* The local account step only exists on the fallback path; cloud
            onboarding is a single profile step, so no stepper is shown. */}
        {startedAtAccount && (
          <Stepper
            steps={[t("steps.account"), t("steps.profile")]}
            current={step === "account" ? 0 : 1}
            className="mb-6"
          />
        )}
        <div className="rounded-12 border border-border bg-surface p-6 shadow-1 sm:p-8">
          {step === "account" ? <AccountStep onDone={() => setStep("profile")} /> : <ProfileStep />}
        </div>
      </div>
    </main>
  );
}

function AccountStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation("onboard");
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

        onDone();
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

function ProfileStep() {
  const { t } = useTranslation("onboard");
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [agent, setAgent] = useState<AgentIdentity>({ name: "", purpose: "" });
  const [presets, setPresets] = useState<AgentIdentity[]>([]);
  const [guardianName, setGuardianName] = useState("");
  const [anyAiConnected, setAnyAiConnected] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  // Bootstrap: load any persisted agent/guardian name and the preset list, and
  // start from a random preset when no agent name is stored yet.
  // AuthGate handles the "onboarding already complete" redirect; we deliberately
  // don't navigate here too, because the two redirect sources race (each
  // location change aborts AuthGate's in-flight state refresh).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/onboard/draft", { credentials: "include" });
        if (!res.ok) return;
        const data = await res.json();
        const loaded = readPresets(data.agentPresets);
        setPresets(loaded);
        const s = data.settings as Record<string, unknown> | undefined;
        const fallback = pickPreset(loaded);
        setAgent((prev) => ({
          name:
            typeof s?.agentName === "string" && s.agentName
              ? s.agentName
              : prev.name || fallback?.name || "",
          purpose:
            typeof s?.agentPurpose === "string" && s.agentPurpose
              ? s.agentPurpose
              : prev.purpose || fallback?.purpose || "",
        }));
        if (typeof s?.guardianName === "string") setGuardianName(s.guardianName);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function rerollAgentName() {
    const preset = pickPreset(presets);
    if (preset) setAgent({ name: preset.name, purpose: preset.purpose });
  }

  async function enterRome() {
    if (!guardianName.trim() || !anyAiConnected) return;

    setSubmitting(true);
    setError("");
    try {
      const setupRes = await fetch("/api/onboard/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: {
            agentName: agent.name || undefined,
            agentPurpose: agent.purpose || undefined,
            guardianName: guardianName.trim() || undefined,
            guardianTimezone: detectTimezone() || undefined,
          },
        }),
      });
      if (!setupRes.ok) {
        const data = await setupRes.json().catch(() => ({}));
        setError(data.error || t("page.errors.profileSaveFailed"));
        return;
      }
      const completeRes = await fetch("/api/onboard/complete", { method: "POST" });
      if (!completeRes.ok) {
        const data = await completeRes.json().catch(() => ({}));
        setError(data.error || t("page.errors.completeFailed"));
        return;
      }
      await queryClient.invalidateQueries({ queryKey: AUTH_QUERY_KEY });
      // Land on the welcome-to-rome app in full mode — the first screen of Rome,
      // shown standalone (no dashboard chrome), which opens the conversational
      // welcome flow. AuthGate independently redirects /onboard ->
      // /full/apps/welcome-to-rome once the auth state above flips to
      // onboardingComplete, so this target MUST match AuthGate's
      // (resolveAuthRouting in lib/auth-routing.ts): both fire on the same state
      // change and, if they disagree, race — the loser's destination can win.
      navigate("/full/apps/welcome-to-rome");
    } catch {
      setError(t("page.errors.networkError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="space-y-6">
        <section>
          <FieldLabel htmlFor="guardianName" className="mb-2">
            {t("guardian.nameLabel")}
          </FieldLabel>
          <Input
            id="guardianName"
            value={guardianName}
            onChange={(e) => setGuardianName(e.target.value)}
            placeholder={t("guardian.namePlaceholder")}
            autoComplete="name"
          />
          <FieldDescription className="mt-2">{t("guardian.nameHint")}</FieldDescription>
        </section>

        <section>
          <FieldLabel htmlFor="agentName" className="mb-2">
            {t("agent.nameLabel")}
          </FieldLabel>
          <div className="flex gap-2">
            <Input
              id="agentName"
              value={agent.name}
              onChange={(e) => setAgent((prev) => ({ ...prev, name: e.target.value }))}
              placeholder={t("agent.namePlaceholder")}
              autoComplete="off"
              className="flex-1"
            />
            <Button
              variant="outline"
              size="md"
              onClick={rerollAgentName}
              title={t("agent.rerollTitle")}
              aria-label={t("agent.rerollTitle")}
            >
              <Dices className="h-4 w-4" aria-hidden />
              <span className="hidden sm:inline">{t("agent.reroll")}</span>
            </Button>
          </div>
          <p className="mt-2 text-aux text-subtle-foreground">{t("agent.nameHint")}</p>
        </section>

        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-section text-foreground">{t("ai.title")}</h2>
            <span className="text-aux text-subtle-foreground">{t("ai.pickOneHint")}</span>
          </div>
          <AiToolsPanel
            hiddenProviders={ONBOARDING_HIDDEN_AI_PROVIDERS}
            showHeader={false}
            showUsage={false}
            onConnectedChange={setAnyAiConnected}
          />
        </section>

        {error && <p className="text-ui text-destructive-fg">{error}</p>}

        <div className="flex flex-col gap-2 border-t border-border pt-5">
          <Button
            size="md"
            onClick={enterRome}
            disabled={submitting || !guardianName.trim() || !anyAiConnected}
            className="w-full touch-target"
          >
            {submitting ? t("page.entering") : t("page.enter")}
          </Button>
          {!anyAiConnected && (
            <p className="text-center text-aux text-subtle-foreground">
              {t("page.enterRequiresAiHint")}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
