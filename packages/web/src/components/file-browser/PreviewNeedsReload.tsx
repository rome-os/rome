import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * In place of a preview whose code is gone after an upgrade: the page has to
 * load again to show it, and the viewer decides when.
 */
export function PreviewNeedsReload() {
  const { t } = useTranslation("files");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-surface p-6">
      <p className="text-ui text-subtle-foreground">{t("view.previewNeedsReload")}</p>
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        {t("view.reload")}
      </Button>
    </div>
  );
}
