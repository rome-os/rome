import { useTranslation } from "react-i18next";
import { REASONING_EFFORT_OPTIONS } from "@/lib/chat-constants";
import type { ReasoningEffort } from "@/lib/chat-types";

export function SessionModelLabel({
  model,
  reasoningEffort,
}: {
  model: string | null | undefined;
  reasoningEffort?: ReasoningEffort | null;
}) {
  const { t } = useTranslation("chat");
  if (!model) return null;

  const effortOption = REASONING_EFFORT_OPTIONS.find((option) => option.id === reasoningEffort);
  const effort = effortOption ? t(effortOption.labelKey) : null;
  const description = effort
    ? t("navbar.sessionModelWithEffort", { model, effort })
    : t("navbar.sessionModel", { model });

  return (
    <span
      className="min-w-0 max-w-full shrink-0 truncate text-aux text-muted-foreground md:max-w-64"
      title={description}
      aria-label={description}
    >
      {effort ? `${model} · ${effort}` : model}
    </span>
  );
}
