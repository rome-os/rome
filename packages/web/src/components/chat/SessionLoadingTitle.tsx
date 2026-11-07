import { useTranslation } from "react-i18next";
import { Spinner } from "@rome-os/ui/spinner";

/** Header title shown while an existing chat's session data is loading. */
export function SessionLoadingTitle() {
  const { t } = useTranslation("chat");
  const label = t("sidebar.loading");
  return (
    <span className="flex min-w-0 items-center gap-2 truncate text-ui text-muted-foreground">
      <Spinner size="sm" label={label} />
      {label}
    </span>
  );
}
