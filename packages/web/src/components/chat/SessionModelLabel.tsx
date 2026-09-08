import { useTranslation } from "react-i18next";

export function SessionModelLabel({ model }: { model: string | null | undefined }) {
  const { t } = useTranslation("chat");
  if (!model) return null;

  return (
    <span
      className="min-w-0 max-w-full shrink-0 truncate text-aux text-muted-foreground md:max-w-48"
      title={t("navbar.sessionModel", { model })}
      aria-label={t("navbar.sessionModel", { model })}
    >
      {model}
    </span>
  );
}
