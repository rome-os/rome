import type { ConciergeConnectorDto, ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { ArrowRight, CalendarDays, Dumbbell, Github, type LucideIcon, Plane } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RomeLogo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateIcon,
  EmptyStateTitle,
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
): TopicStarter[] {
  const starters: TopicStarter[] = [];
  const calendar = connectors.find((connector) => /calendar/i.test(connector.service));
  if (calendar && (calendar.state === "working" || followsOf(calendar).length > 0)) {
    starters.push({ kind: "calendar", text: t("concierge.topicEmpty.starters.calendar") });
  }
  const repo = followsOf(connectors.find((connector) => connector.service === "github"))[0];
  if (repo) {
    starters.push({
      kind: "github",
      text: t("concierge.topicEmpty.starters.github", { repo: repo.target }),
    });
  }
  for (const kind of ["trip", "fitness"] as const) {
    if (starters.length >= 3 || (starters.length >= 2 && kind === "fitness")) break;
    starters.push({ kind, text: t(`concierge.topicEmpty.starters.${kind}`) });
  }
  return starters;
}

/** One starter: what it is about, and the first message it sends. */
export interface TopicStarter {
  kind: "calendar" | "github" | "trip" | "fitness";
  text: string;
}

const STARTER_ICONS: Record<TopicStarter["kind"], LucideIcon> = {
  calendar: CalendarDays,
  github: Github,
  trip: Plane,
  fitness: Dumbbell,
};

/**
 * What a blank topic chat shows before its first message: what a topic chat
 * is for, two or three starters that send themselves as its first message, and
 * a way back to the main chat for a one-off question.
 */
export function ConciergeTopicEmptyState({ onStart }: { onStart: (prompt: string) => void }) {
  const { t } = useTranslation("chat");
  // What the guardian has, read once: without it the starters are generic ones.
  // Null until the list answers, so the starters show once, in their final set.
  const [connectors, setConnectors] = useState<ConciergeConnectorDto[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetchJson<ConciergeConnectorsResponse>("/api/concierge/connectors", {
      signal: controller.signal,
      fallback: "",
    })
      .then((data) => setConnectors(data.connectors))
      .catch(() => {
        if (!controller.signal.aborted) setConnectors([]);
      });
    return () => controller.abort();
  }, []);
  const starters = connectors ? topicStarters(connectors, t) : null;
  const titleId = useId();
  // One hero line, a description at reading size, and the starters as the
  // focal point: the same column and rhythm as the other empty states, with
  // more weight where the guardian acts.
  return (
    <div className="flex flex-1 flex-col justify-center px-4 py-10 md:px-6">
      <section
        role="region"
        aria-labelledby={titleId}
        data-concierge-topic-empty
        className="mx-auto flex w-full max-w-lg flex-col items-center text-center"
      >
        <RomeLogo className="h-9 w-9 text-foreground" aria-hidden />
        <h2 id={titleId} className="mt-5 text-display [text-wrap:balance] text-foreground">
          {t("concierge.topicEmpty.title")}
        </h2>
        <p className="mt-3 text-ui [text-wrap:pretty] text-foreground">
          {t("concierge.topicEmpty.description")}
        </p>
        {/* Every starter takes the column's width, and a long one wraps inside
            its border instead of running past it. */}
        <div
          className="mt-8 flex min-h-[calc(2*3.5rem+0.75rem)] w-full flex-col gap-3"
          aria-busy={starters === null}
          data-concierge-topic-starters
        >
          {starters?.map(({ kind, text }) => {
            const Icon = STARTER_ICONS[kind];
            return (
              <Button
                key={text}
                type="button"
                variant="outline"
                className="group/starter h-auto min-h-14 w-full shrink justify-start gap-3 whitespace-normal px-4 py-3 text-left"
                onClick={() => onStart(text)}
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-[var(--control-r-sm)] bg-surface text-muted-foreground"
                  aria-hidden
                >
                  <Icon />
                </span>
                <span className="min-w-0 flex-1 [text-wrap:pretty]">{text}</span>
                <ArrowRight
                  className="text-subtle-foreground transition-transform group-hover/starter:translate-x-0.5"
                  aria-hidden
                />
              </Button>
            );
          })}
        </div>
        <p className="mt-8 text-ui text-muted-foreground">
          {t("concierge.topicEmpty.justAsk")}{" "}
          <Link
            to={`/chat/${CONCIERGE_CHAT_ID}`}
            className="whitespace-nowrap text-foreground underline-offset-4 hover:underline"
          >
            {t("concierge.topicEmpty.backToMain")}
          </Link>
        </p>
      </section>
    </div>
  );
}
