import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { ArrowRight, CircleAlert } from "lucide-react";
import { Link } from "react-router-dom";
import type { TraceAccounting } from "@rome/api-types/trace-segments";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { ChatErrorCode, ChatErrorProvider, ChatErrorReason } from "@/lib/chat-types";
import { cn } from "@/lib/utils";
import { UsageSummaryView } from "./UsageSummaryView";

export interface ErrorEventViewProps {
  error: string;
  code?: ChatErrorCode;
  provider?: ChatErrorProvider;
  reason?: ChatErrorReason;
  presentation?: "block" | "status";
  className?: string;
}

function providerName(provider?: ChatErrorProvider): string {
  if (provider === "openai") return "Codex";
  if (provider === "anthropic") return "Claude";
  return "AI tool";
}

interface GuidedErrorCopy {
  title: string;
  description: string;
  action: string;
}

/** Copy for the errors that point the guardian at AI Tools. */
function getGuidedErrorCopy(
  t: TFunction<"chat">,
  code: ChatErrorCode | undefined,
  provider: ChatErrorProvider | undefined,
  reason: ChatErrorReason | undefined,
): GuidedErrorCopy {
  const name = providerName(provider);
  if (code === "credits_used_up") {
    return {
      title: t("errors.creditsUsedUp.title"),
      description: t("errors.creditsUsedUp.description"),
      action: t("errors.creditsUsedUp.action"),
    };
  }
  if (code === "auth_revoked") {
    return {
      title: t("errors.providerAuthRevoked.title", { provider: name }),
      description: t("errors.providerAuthRevoked.description", { provider: name }),
      action: t("errors.providerAuthRevoked.action"),
    };
  }
  if (reason === "not_logged_in") {
    return {
      title: t("errors.providerNotLoggedIn.title", { provider: name }),
      description: t("errors.providerNotLoggedIn.description", { provider: name }),
      action: t("errors.providerNotLoggedIn.action"),
    };
  }
  if (reason === "quota_exhausted") {
    return provider
      ? {
          title: t("errors.providerQuotaExhausted.title", { provider: name }),
          description: t("errors.providerQuotaExhausted.description", { provider: name }),
          action: t("errors.openAiTools"),
        }
      : {
          title: t("errors.allProvidersQuotaExhausted.title"),
          description: t("errors.allProvidersQuotaExhausted.description"),
          action: t("errors.openAiTools"),
        };
  }
  if (reason === "model_access_denied") {
    return {
      title: t("errors.modelUnavailable.title"),
      description: t("errors.modelUnavailable.description"),
      action: t("errors.openAiTools"),
    };
  }
  return {
    title: t("errors.noProvider.title"),
    description: t("errors.noProvider.description"),
    action: t("errors.openAiTools"),
  };
}

export function ErrorEventView({
  error,
  code,
  provider,
  reason,
  presentation = "block",
  className,
}: ErrorEventViewProps) {
  const { t } = useTranslation("chat");
  const isModelResolutionError =
    code === "model_provider_unavailable" ||
    code === "model_unavailable" ||
    code === "no_model_provider_available";
  const isAuthRevokedError = code === "auth_revoked";
  const isCreditsUsedUpError = code === "credits_used_up";

  if (isModelResolutionError || isAuthRevokedError || isCreditsUsedUpError) {
    const copy = getGuidedErrorCopy(t, code, provider, reason);

    if (presentation === "status") {
      return (
        <div
          role="alert"
          className={cn(
            "flex w-full flex-col gap-2 rounded-12 border border-border bg-surface/95 px-3 py-2 shadow-1 backdrop-blur-md sm:flex-row sm:items-center supports-[backdrop-filter]:bg-surface/85",
            className,
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <CircleAlert className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 sm:flex sm:items-baseline sm:gap-2">
              <div className="shrink-0 text-ui text-foreground">{copy.title}</div>
              <div className="truncate text-aux text-muted-foreground">{copy.description}</div>
            </div>
          </div>
          <Button asChild size="sm" press="none" className="w-full shadow-1 sm:w-auto">
            <Link to="/settings/ai-tools">
              {copy.action}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </div>
      );
    }

    return (
      <Alert variant="destructive" className={cn("mb-2 rounded-12 px-3 py-3", className)}>
        <CircleAlert aria-hidden />
        <AlertTitle>{copy.title}</AlertTitle>
        <AlertDescription className="text-aux">
          <span className="block">{copy.description}</span>
          <Button asChild size="xs" className="mt-2 shadow-1">
            <Link to="/settings/ai-tools">
              {copy.action}
              <ArrowRight data-icon="inline-end" />
            </Link>
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (presentation === "status") {
    return (
      <div
        role="alert"
        className={cn(
          "flex w-full items-center gap-2 rounded-12 border border-border bg-surface/95 px-3 py-2 text-ui text-foreground shadow-1 backdrop-blur-md supports-[backdrop-filter]:bg-surface/85",
          className,
        )}
      >
        <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{error}</span>
      </div>
    );
  }

  return (
    <Alert variant="destructive" className={cn("mb-2 rounded-4 px-3 py-2", className)}>
      <AlertDescription className="text-aux">{error}</AlertDescription>
    </Alert>
  );
}

export function ErrorRunView({
  error,
  accounting,
  code,
  provider,
  reason,
}: {
  error?: string;
  accounting?: TraceAccounting;
  code?: ChatErrorCode;
  provider?: ChatErrorProvider;
  reason?: ChatErrorReason;
}) {
  const { t } = useTranslation("chat");
  return (
    <div>
      <ErrorEventView
        error={error ?? t("blocks.agentRunFailed")}
        code={code}
        provider={provider}
        reason={reason}
      />
      {accounting ? <UsageSummaryView accounting={accounting} /> : null}
    </div>
  );
}
