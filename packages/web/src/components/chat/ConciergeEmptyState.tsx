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
