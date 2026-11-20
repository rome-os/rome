import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type {
  DefaultModelProvider,
  ProviderFailureCardKind,
  ProviderFailurePart,
  ProviderFailureReason,
  ProviderFailureResolution,
} from "@rome/api-types/chat";
import { LabeledCheckbox, useProviderName } from "@/components/default-provider";
import { ChatNotice } from "@/components/chat/ChatNotice";
import { ProviderSignIn } from "@/components/chat/ProviderSignIn";
import { Button } from "@/components/ui/button";
import { type ProviderSwitch, switchProviderFailure } from "@/hooks/use-default-provider";
import { modelDisplayName } from "@/lib/model-display";
import { cn } from "@/lib/utils";

/**
 * When a usage limit ends, as a day the guardian reads at a glance: today,
 * tomorrow, or a date, and the time of day.
 */
export function formatUntil(
  until: string,
  locale: string,
  now = new Date(),
): { day: "today" | "tomorrow" | "date"; date: string; time: string } {
  const at = new Date(until);
  const time = Number.isNaN(at.getTime())
    ? until
    : new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at);
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const days = Math.round((startOf(at).getTime() - startOf(now).getTime()) / 86_400_000);
  const date = Number.isNaN(at.getTime())
    ? until
    : new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(at);
  return { day: days <= 0 ? "today" : days === 1 ? "tomorrow" : "date", date, time };
}

/** What a failure asks of the guardian. A part written before `card` existed
 *  reads it from its reason. */
export function failureCardKind(part: {
  card?: ProviderFailureCardKind;
  reason: ProviderFailureReason;
}): ProviderFailureCardKind {
  if (part.card) return part.card;
  if (part.reason === "quota" || part.reason === "temporary" || part.reason === "capacity") {
    return "wait";
  }
  return part.reason === "model_unavailable" ? "model" : "account";
}

/** The fields a card and an outage notice share. */
export interface FailureFacts {
  provider: DefaultModelProvider;
  reason: ProviderFailureReason;
  until?: string;
  card?: ProviderFailureCardKind;
  model?: string;
  alternatives: DefaultModelProvider[];
  credits?: boolean;
  replacement?: { selection: string; model: string };
  detail?: string;
}

/** The card's one line on what stopped. */
export function failureText(
  facts: FailureFacts,
  t: TFunction<"chat">,
  providerName: (provider: DefaultModelProvider) => string,
  locale: string,
): string {
  const provider = providerName(facts.provider);
  const model = facts.model ? modelDisplayName(facts.model) : provider;
  switch (facts.reason) {
    case "quota":
      return facts.until
        ? (() => {
            const { day, date, time } = formatUntil(facts.until, locale);
            return day === "today"
              ? t("providerFailure.quotaUntilToday", { provider, time })
              : day === "tomorrow"
                ? t("providerFailure.quotaUntilTomorrow", { provider, time })
                : t("providerFailure.quotaUntil", { provider, date, time });
          })()
        : t("providerFailure.quota", { provider });
    case "temporary":
      return t("providerFailure.temporary", { provider });
    case "capacity":
      return t("providerFailure.temporary", { provider: model });
    case "login":
      return t("providerFailure.login", { provider });
    case "removed":
      return t("providerFailure.removed", { provider });
    case "credits_used_up":
      return t("providerFailure.creditsUsedUp");
    case "spend_cap":
      return t("providerFailure.spendCap", { provider });
    case "model_unavailable":
      return t("providerFailure.modelUnavailable", { model });
    default: {
      const kind = failureCardKind(facts);
      return kind === "wait"
        ? t("providerFailure.temporary", { provider })
        : kind === "model"
          ? t("providerFailure.modelUnavailable", { model })
          : t("providerFailure.account", { provider });
    }
  }
}

/** The one line a settled card or notice reads as. */
export function resolvedText(
  resolved: Pick<ProviderFailureResolution, "by" | "provider" | "model" | "continued">,
  t: TFunction<"chat">,
  providerName: (provider: DefaultModelProvider) => string,
): string {
  const target = resolved.model
    ? modelDisplayName(resolved.model)
    : resolved.provider
      ? providerName(resolved.provider)
      : null;
  const ran = resolved.continued !== false;
  if (resolved.by === "switched" && target) {
    return t(ran ? "providerFailure.switchedContinued" : "providerFailure.switched", { target });
  }
  return t(ran ? "providerFailure.recoveredContinued" : "providerFailure.recovered");
}

/**
 * The buttons a failure offers, grouped by what the guardian has to do:
 * switch to another account (`wait`), log in or switch (`account`), or move
 * to another model (`model`). A provider switch moves this chat only, unless
 * "Also make default" is checked.
 */
export function FailureActions({
  facts,
  pending,
  failed,
  onSwitch,
  centered = false,
}: {
  facts: FailureFacts;
  pending: boolean;
  failed: boolean;
  onSwitch: (change: ProviderSwitch) => void;
  /** Center the rows, as the main chat's notice is. */
  centered?: boolean;
}) {
  const { t } = useTranslation("chat");
  const providerName = useProviderName();
  const [makeDefault, setMakeDefault] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const kind = failureCardKind(facts);
  const providers =
    kind === "model"
      ? []
      : [
          ...facts.alternatives.filter((provider) => provider !== "rome_credits"),
          ...(kind === "account" && facts.credits ? (["rome_credits"] as const) : []),
        ];
  const replacement = kind === "model" ? facts.replacement : undefined;
  const canLogIn = kind === "account" && facts.reason !== "credits_used_up";
  return (
    <div className={cn(centered && "flex flex-col items-center")}>
      {(canLogIn || providers.length > 0 || replacement) && (
        <div className={cn("mt-3 flex flex-wrap items-center gap-2", centered && "justify-center")}>
          {canLogIn && (
            <Button
              type="button"
              size="sm"
              aria-expanded={signInOpen}
              onClick={() => setSignInOpen((open) => !open)}
            >
              {t("providerFailure.logIn")}
            </Button>
          )}
          {providers.map((provider, index) => (
            <Button
              key={provider}
              type="button"
              size="sm"
              variant={!canLogIn && index === 0 ? "default" : "outline"}
              disabled={pending}
              onClick={() => onSwitch({ kind: "provider", provider, makeDefault })}
            >
              {provider === "rome_credits"
                ? t("providerFailure.useCredits")
                : t("providerFailure.switchTo", { target: providerName(provider) })}
            </Button>
          ))}
          {replacement && (
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => onSwitch({ kind: "model", selection: replacement.selection })}
            >
              {t("providerFailure.switchTo", { target: modelDisplayName(replacement.model) })}
            </Button>
          )}
        </div>
      )}
      {providers.length > 0 && (
        <div className="mt-2">
          <LabeledCheckbox
            checked={makeDefault}
            disabled={pending}
            onCheckedChange={setMakeDefault}
          >
            {t("providerFailure.alsoMakeDefault")}
          </LabeledCheckbox>
        </div>
      )}
      {failed && (
        <p role="alert" className="mt-2 text-aux text-destructive">
          {t("providerFailure.switchFailed")}
        </p>
      )}
      {signInOpen && (
        <div className="mt-4 w-full max-w-xl text-left">
          <ProviderSignIn />
        </div>
      )}
      {facts.detail && (
        <div className={cn("mt-3 w-full", !centered && "text-left")}>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-aux text-muted-foreground hover:text-foreground"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((open) => !open)}
          >
            <ChevronRight
              aria-hidden
              className={cn("size-3 transition-transform", detailOpen && "rotate-90")}
            />
            {t("providerFailure.details")}
          </button>
          {detailOpen && (
            <pre className="mt-1 max-h-48 text-left overflow-auto whitespace-pre-wrap break-words rounded-8 bg-surface-muted px-2 py-1 text-aux text-muted-foreground">
              {facts.detail}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The card Rome writes into a chat whose turn could not run on its provider.
 * Rome never moves the chat on its own, so the card offers the ways forward,
 * and the server settles it once the chat runs again: the card then reads as
 * one line. `messageId` is the stored message the card is in, which its
 * switch names. docs/domains/agents.md#provider-failure
 */
export function ProviderFailureCard({
  part,
  messageId,
  onSettled,
}: {
  part: ProviderFailurePart;
  messageId?: string;
  /** Reads the chat again once the server settled the card. */
  onSettled?: () => void;
}) {
  const { t, i18n } = useTranslation("chat");
  const providerName = useProviderName();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  // What a switch this view sent settled the card as, until the chat is read again.
  const [switched, setSwitched] = useState<ProviderFailureResolution | null>(null);
  const resolved = part.resolved ?? switched;

  // A quiet retry, or a card a later turn carries now: nothing to show here.
  if (part.retrying || resolved?.by === "moved") return null;

  if (resolved) {
    return (
      <div data-provider-failure-resolved="" className="contents">
        <ChatNotice>{resolvedText(resolved, t, providerName)}</ChatNotice>
      </div>
    );
  }

  const onSwitch = async (change: ProviderSwitch) => {
    if (!messageId) return;
    setPending(true);
    setFailed(false);
    try {
      await switchProviderFailure(messageId, change);
      setSwitched({
        at: new Date().toISOString(),
        by: "switched",
        ...(change.kind === "provider"
          ? { provider: change.provider }
          : { model: part.replacement?.model }),
      });
      onSettled?.();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <div
      className="mb-4 w-full max-w-md rounded-12 border border-border bg-surface p-4"
      data-provider-failure=""
      data-card={failureCardKind(part)}
    >
      <p className="text-ui text-foreground">{failureText(part, t, providerName, i18n.language)}</p>
      <FailureActions
        facts={part}
        pending={pending || !messageId}
        failed={failed}
        onSwitch={(change) => void onSwitch(change)}
      />
    </div>
  );
}
