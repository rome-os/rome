import type { ConciergeConnectorDto, ConciergeConnectorsResponse } from "@rome/api-types/concierge";
import { useTranslation } from "react-i18next";
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

/** The suggestions a blank topic chat offers, the same for everyone. */
const TOPIC_STARTERS = ["life", "work", "trip"] as const;

/**
 * What a blank topic chat shows before its first message: three suggestions on
 * the composer's edge, right above it. Picking one puts its full message in
 * the composer, unsent. The welcome is the header's status capsule (see
 * `Chat`), so this holds nothing else.
 */
export function ConciergeTopicEmptyState({ onStart }: { onStart: (prompt: string) => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="flex flex-1 flex-col justify-end px-3 md:px-6">
      {/* The composer floor's geometry, so the suggestions share its left edge. */}
      <section
        role="region"
        aria-label={t("concierge.topicEmpty.label")}
        data-concierge-topic-empty
        className="mx-auto flex w-full max-w-5xl flex-wrap gap-2 px-1 pb-4"
      >
        {TOPIC_STARTERS.map((key) => (
          <Button
            key={key}
            type="button"
            variant="outline"
            size="sm"
            shape="pill"
            onClick={() => onStart(t(`concierge.topicEmpty.starters.${key}.text`))}
          >
            {t(`concierge.topicEmpty.starters.${key}.label`)}
          </Button>
        ))}
      </section>
    </div>
  );
}
