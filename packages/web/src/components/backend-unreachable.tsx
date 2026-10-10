import { useTranslation } from "react-i18next";

interface BackendUnreachableScreenProps {
  retryIntervalMs: number;
}

export function BackendUnreachableScreen({ retryIntervalMs }: BackendUnreachableScreenProps) {
  const { t } = useTranslation("common");
  const seconds = Math.max(1, Math.round(retryIntervalMs / 1000));
  return (
    <main
      role="alert"
      aria-live="assertive"
      className="flex min-h-screen items-center justify-center bg-surface-muted px-4"
    >
      <div className="w-full max-w-md text-center">
        <h1 className="mb-2 text-title text-foreground">{t("backendUnreachable.title")}</h1>
        <p className="mb-6 text-ui text-muted-foreground">{t("backendUnreachable.description")}</p>
        <p className="text-aux text-subtle-foreground">
          {t("backendUnreachable.retrying", { seconds })}
        </p>
      </div>
    </main>
  );
}
