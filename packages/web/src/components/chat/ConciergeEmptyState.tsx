import type { ConciergeConnectorDto, ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { ArrowRight, Briefcase, House, type LucideIcon, Plane } from "lucide-react";
import { useId } from "react";
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

/**
 * The starters a blank topic chat offers: three kinds of ongoing topic, the
 * same for everyone, so they show at once. Picking one sends it as the chat's
 * first message, and the Concierge works out what to follow from there.
 */
const TOPIC_STARTERS: ReadonlyArray<{ key: "life" | "work" | "trip"; icon: LucideIcon }> = [
  { key: "life", icon: House },
  { key: "work", icon: Briefcase },
  { key: "trip", icon: Plane },
];

/**
 * What a blank topic chat shows before its first message: what a topic chat
 * is for, three starters that send themselves as its first message, and
 * a way back to the main chat for a one-off question.
 */
export function ConciergeTopicEmptyState({
  mainChatId,
  onStart,
}: {
  /** The signed-in person's main Concierge chat, which the back link opens. */
  mainChatId: string;
  onStart: (prompt: string) => void;
}) {
  const { t } = useTranslation("chat");
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
        <div className="mt-8 flex w-full flex-col gap-3" data-concierge-topic-starters>
          {TOPIC_STARTERS.map(({ key, icon: Icon }) => {
            const text = t(`concierge.topicEmpty.starters.${key}`);
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
            to={`/chat/${mainChatId}`}
            className="whitespace-nowrap text-foreground underline-offset-4 hover:underline"
          >
            {t("concierge.topicEmpty.backToMain")}
          </Link>
        </p>
      </section>
    </div>
  );
}
