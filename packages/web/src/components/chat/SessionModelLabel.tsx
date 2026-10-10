import { useTranslation } from "react-i18next";

/** The session's model, followed by its last turn's effort in the provider's own terms. */
export function SessionModelLabel({
  model,
  reasoningEffort,
}: {
  model: string | null | undefined;
  reasoningEffort?: string | null;
}) {
  const { t } = useTranslation("chat");
  if (!model) return null;

  const description = reasoningEffort
    ? t("navbar.sessionModelWithEffort", { model, effort: reasoningEffort })
    : t("navbar.sessionModel", { model });

  return (
    <span
      className="min-w-0 max-w-full shrink-0 truncate text-aux text-muted-foreground md:max-w-64"
      title={description}
      aria-label={description}
    >
      {reasoningEffort ? `${model} · ${reasoningEffort}` : model}
    </span>
  );
}
