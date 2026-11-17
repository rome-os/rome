import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderOutagePart } from "@rome/api-types/chat";
import { MakeDefaultProviderButton, useProviderName } from "@/components/default-provider";
import { ProviderSignIn } from "@/components/chat/ProviderSignIn";
import { formatUntil } from "@/components/chat/entries/ProviderFailureCard";
import { Button } from "@/components/ui/button";
import { useProviderOutages, useRunOutageOn } from "@/hooks/use-default-provider";
import { cn } from "@/lib/utils";

/**
 * The Concierge main chat's line for unattended chats (task chats, routines)
 * waiting on a provider that stopped working. The open outages are read live,
 * so the count is current and the actions go once the outage resolves.
 */
export function ProviderOutageNotice({
  part,
  className,
}: {
  part: ProviderOutagePart;
  className?: string;
}) {
  const { t, i18n } = useTranslation("chat");
  const providerName = useProviderName();
  const outages = useProviderOutages();
  const runOn = useRunOutageOn();
  const [signInOpen, setSignInOpen] = useState(false);
  const live = outages.data?.find((outage) => outage.id === part.outageId);
  const resolved = !!part.resolvedAt || (outages.isSuccess && !live);
  const name = providerName(part.provider);
  const count = live?.chatIds.length ?? part.chatIds.length;
  const untilIso = live?.until ?? part.until;
  const until = untilIso ? formatUntil(untilIso, i18n.language) : null;
  const reason = live?.reason ?? part.reason;

  const text = resolved
    ? t("providerOutage.resolved", { provider: name })
    : reason === "quota"
      ? until
        ? t("providerOutage.quotaUntil", { provider: name, time: until, count })
        : t("providerOutage.quota", { provider: name, count })
      : reason === "login"
        ? t("providerOutage.login", { provider: name, count })
        : t("providerOutage.removed", { provider: name, count });

  const runnable = part.alternatives.filter(
    (alternative): alternative is "anthropic" | "openai" =>
      alternative === "anthropic" || alternative === "openai",
  );

  return (
    <div role="note" className={cn("mb-4 text-center", className)}>
      <p className="text-aux text-muted-foreground">{text}</p>
      {!resolved && (
        <>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
            {runnable.map((alternative) => (
              <Button
                key={`run-${alternative}`}
                type="button"
                size="sm"
                variant="outline"
                disabled={runOn.isPending}
                onClick={() => runOn.mutate({ outageId: part.outageId, provider: alternative })}
              >
                {t("providerOutage.runOn", { provider: providerName(alternative) })}
              </Button>
            ))}
            {part.alternatives.map((alternative) => (
              <MakeDefaultProviderButton
                key={`default-${alternative}`}
                provider={alternative}
                variant="ghost"
                label={t("providerFailure.makeDefault", { provider: providerName(alternative) })}
              />
            ))}
            {reason !== "quota" && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                aria-expanded={signInOpen}
                onClick={() => setSignInOpen((open) => !open)}
              >
                {t("providerFailure.signIn")}
              </Button>
            )}
          </div>
          {runOn.isError && (
            <p role="alert" className="mt-2 text-aux text-destructive">
              {t("providerOutage.runFailed")}
            </p>
          )}
          {signInOpen && (
            <div className="mx-auto mt-3 max-w-xl text-left">
              <ProviderSignIn />
            </div>
          )}
        </>
      )}
    </div>
  );
}
