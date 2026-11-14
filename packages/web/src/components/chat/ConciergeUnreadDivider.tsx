import { memo } from "react";
import { useTranslation } from "react-i18next";

/** The line above the first message that was unread when the chat opened. */
export const ConciergeUnreadDivider = memo(function ConciergeUnreadDivider() {
  const { t } = useTranslation("chat");
  const label = t("concierge.newMessages");
  return (
    <div
      role="separator"
      aria-label={label}
      data-concierge-unread-divider
      className="flex items-center gap-3 text-aux text-muted-foreground"
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span aria-hidden>{label}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
});
