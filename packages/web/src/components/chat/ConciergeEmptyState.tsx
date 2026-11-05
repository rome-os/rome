import type { ConciergeConnectorDto, ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDescription,
} from "@/components/ui/empty-state";
import { CONCIERGE_CHAT_ID } from "@/hooks/use-concierge";
import { fetchJson } from "@/lib/fetch-json";

const PROMPT_KEYS = [
  "concierge.empty.prompts.weather",
  "concierge.empty.prompts.reminder",
  "concierge.empty.prompts.email",
  "concierge.empty.prompts.task",
] as const;

/**
 * What the Concierge chat shows before its first message: one line inviting a
 * request, and a few example messages. Picking one hands its text to `onPick`.
 */
export function ConciergeEmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex flex-1 flex-col justify-center px-3 md:px-6">
      <EmptyState role="region">
        <EmptyStateIcon>
          <RomeLogo aria-hidden />
        </EmptyStateIcon>
        <EmptyStateTitle>{t("concierge.empty.title")}</EmptyStateTitle>
        <EmptyStateAction className="mt-6 w-full flex-col items-stretch">
          {PROMPT_KEYS.map((key) => {
            const prompt = t(key);
            return (
              <Button key={key} type="button" variant="outline" onClick={() => onPick(prompt)}>
                {prompt}
              </Button>
            );
          })}
        </EmptyStateAction>
      </EmptyState>
    </div>
  );
}

/** A connector's follows, or none. */
const followsOf = (connector: ConciergeConnectorDto | undefined) =>
  connector?.capabilities.watch.follows ?? [];

/**
 * The starters a blank topic chat offers, from what the guardian already has:
 * calendar alerts when a calendar is followed or connected, a followed GitHub
 * repository's pull requests and CI, then generic ongoing topics, two or three
 * in all.
 */
export function topicStarters(
  connectors: readonly ConciergeConnectorDto[],
  t: (key: string, options?: Record<string, string>) => string,
): string[] {
  const starters: string[] = [];
  const calendar = connectors.find((connector) => /calendar/i.test(connector.service));
  if (calendar && (calendar.state === "working" || followsOf(calendar).length > 0)) {
    starters.push(t("concierge.topicEmpty.starters.calendar"));
  }
  const repo = followsOf(connectors.find((connector) => connector.service === "github"))[0];
  if (repo) starters.push(t("concierge.topicEmpty.starters.github", { repo: repo.target }));
  for (const key of ["trip", "fitness"]) {
    if (starters.length >= 3 || (starters.length >= 2 && key === "fitness")) break;
    starters.push(t(`concierge.topicEmpty.starters.${key}`));
  }
  return starters;
}

/**
 * What a blank topic chat shows before its first message: what a topic chat
 * is for, two or three starters that send themselves as its first message, and
 * a way back to the main chat for a one-off question.
 */
export function ConciergeTopicEmptyState({ onStart }: { onStart: (prompt: string) => void }) {
  const { t } = useTranslation("chat");
  // What the guardian has, read once: without it the starters are generic ones.
  const [connectors, setConnectors] = useState<ConciergeConnectorDto[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<ConciergeConnectorsResponse>("/api/concierge/connectors", {
      signal: controller.signal,
      fallback: "",
    })
      .then((data) => setConnectors(data.connectors))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  const starters = topicStarters(connectors, t);
  return (
    <div className="flex flex-1 flex-col justify-center px-3 md:px-6">
      <EmptyState role="region" data-concierge-topic-empty>
        <EmptyStateIcon>
          <RomeLogo aria-hidden />
        </EmptyStateIcon>
        <EmptyStateTitle>{t("concierge.topicEmpty.title")}</EmptyStateTitle>
        <EmptyStateDescription>{t("concierge.topicEmpty.description")}</EmptyStateDescription>
        <EmptyStateAction className="mt-6 w-full flex-col items-stretch">
          {starters.map((prompt) => (
            <Button key={prompt} type="button" variant="outline" onClick={() => onStart(prompt)}>
              {prompt}
            </Button>
          ))}
        </EmptyStateAction>
        <p className="mt-6 text-ui text-muted-foreground">
          {t("concierge.topicEmpty.justAsk")}{" "}
          <Link
            to={`/chat/${CONCIERGE_CHAT_ID}`}
            className="text-foreground underline-offset-4 hover:underline"
          >
            {t("concierge.topicEmpty.backToMain")}
          </Link>
        </p>
      </EmptyState>
    </div>
  );
}
