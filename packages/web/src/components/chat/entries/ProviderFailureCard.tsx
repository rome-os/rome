import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { DefaultModelProvider, ProviderFailurePart } from "@rome/api-types/chat";
import { MakeDefaultProviderButton, useProviderName } from "@/components/default-provider";
import { ProviderSignIn } from "@/components/chat/ProviderSignIn";
import { Button } from "@/components/ui/button";
import { resendProviderFailure, useSignedInProviders } from "@/hooks/use-default-provider";
import { getSession, updateSessionModel } from "@/lib/chat-api";
import { DEFAULT_LARGE_MODEL_SELECTION } from "@/lib/chat-constants";
import { emitSessionsChanged } from "@/lib/session-events";

/** `until` as a time of day, with the date when it is not today. */
export function formatUntil(until: string, locale: string, now = new Date()): string {
  const at = new Date(until);
  if (Number.isNaN(at.getTime())) return until;
  const sameDay = at.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/** The agent the chat's request ran on, which a resend runs on again. */
async function chatAgentName(chatId: string): Promise<string> {
  return (await getSession(chatId))?.agentName ?? "main";
}

/** Whether `provider` reads as signed in. Rome credits count once usable. */
function signedIn(state: Record<DefaultModelProvider, boolean> | null, p: DefaultModelProvider) {
  return state?.[p] === true;
}

type Phase = "idle" | "working" | "sent" | "failed";

/**
 * The card Rome writes into a chat whose turn could not run on its provider.
 * Rome never moves the chat on its own, so the card offers the ways forward:
 * make another signed-in provider the default, sign in again, or, for a chat
 * on an exact model, go back to following the default. Each one runs the
 * stopped request again. docs/domains/agents.md#default-provider
 */
export function ProviderFailureCard({ part }: { part: ProviderFailurePart }) {
  const { t, i18n } = useTranslation("chat");
  const providerName = useProviderName();
  const signedInProviders = useSignedInProviders();
  const [signInOpen, setSignInOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const name = providerName(part.provider);
  const until = part.until ? formatUntil(part.until, i18n.language) : null;
  const followsDefault = part.followsDefault === true;
  const canSignIn = part.reason !== "quota";
  const backSignedIn = canSignIn && signedIn(signedInProviders, part.provider);

  const run = async (action: () => Promise<unknown>) => {
    setPhase("working");
    try {
      await action();
      setPhase("sent");
      setSignInOpen(false);
    } catch {
      setPhase("failed");
    }
  };

  const resend = () =>
    run(async () => resendProviderFailure(part.chatId, await chatAgentName(part.chatId)));

  const backToDefault = () =>
    run(async () => {
      await updateSessionModel(part.chatId, DEFAULT_LARGE_MODEL_SELECTION);
      emitSessionsChanged();
      await resendProviderFailure(part.chatId, await chatAgentName(part.chatId));
    });

  const reason =
    part.reason === "quota"
      ? until
        ? t("providerFailure.quotaUntil", { provider: name, time: until })
        : t("providerFailure.quota", { provider: name })
      : part.reason === "login"
        ? t("providerFailure.login", { provider: name })
        : t("providerFailure.removed", { provider: name });

  const settled = phase === "sent";

  return (
    <div className="mb-4 rounded-12 border border-border bg-surface" data-provider-failure="">
      <div className="p-4">
        <p className="text-ui text-foreground">{reason}</p>
        {settled ? (
          <p className="mt-1 text-aux text-muted-foreground">{t("providerFailure.sent")}</p>
        ) : (
          <>
            {part.reason === "quota" && until && (
              <p className="mt-1 text-aux text-muted-foreground">
                {t("providerFailure.retriesAt", { time: until })}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {followsDefault ? (
                part.alternatives.map((alternative, index) => (
                  <MakeDefaultProviderButton
                    key={alternative}
                    provider={alternative}
                    variant={index === 0 ? "default" : "outline"}
                    label={t("providerFailure.makeDefault", {
                      provider: providerName(alternative),
                    })}
                    resend={async () => ({
                      chatId: part.chatId,
                      agentName: await chatAgentName(part.chatId),
                    })}
                    onDone={() => setPhase("sent")}
                  />
                ))
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={phase === "working"}
                  onClick={() => void backToDefault()}
                >
                  {t("providerFailure.backToDefault")}
                </Button>
              )}
              {backSignedIn ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={phase === "working"}
                  onClick={() => void resend()}
                >
                  {t("providerFailure.resend")}
                </Button>
              ) : canSignIn ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-expanded={signInOpen}
                  onClick={() => setSignInOpen((open) => !open)}
                >
                  {t("providerFailure.signIn")}
                </Button>
              ) : null}
            </div>
            {phase === "failed" && (
              <p role="alert" className="mt-2 text-aux text-destructive">
                {t("providerFailure.failed")}
              </p>
            )}
            {signInOpen && !backSignedIn && (
              <div className="mt-4">
                <ProviderSignIn />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
