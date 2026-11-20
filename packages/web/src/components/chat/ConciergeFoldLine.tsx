import { memo } from "react";
import { useTranslation } from "react-i18next";

/**
 * The line that stands in for the messages folded away, at the top of the
 * main chat. A tap shows them again for this visit; the fold itself stays.
 */
export const ConciergeFoldLine = memo(function ConciergeFoldLine({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <div data-concierge-fold className="flex items-center gap-3 text-aux text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <button
        type="button"
        onClick={onOpen}
        className="touch-target inline-flex items-center gap-1 rounded-full px-3 outline-1 outline-offset-0 outline-transparent transition-colors hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring/50"
      >
        <span>{t("concierge.fold.line")}</span>
        <span aria-hidden>·</span>
        <span className="text-foreground">{t("concierge.fold.show")}</span>
      </button>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
});
