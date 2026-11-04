import { BellRing, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useToolFollowing } from "@/pages/free/tool-tasks";
import { ConciergeFollowingPanel } from "./ConciergeFollowingPanel";
import { useConciergeFollowing } from "./use-concierge-following";

/**
 * The Concierge chat's second header pill, beside Tasks: how many things it
 * follows for the guardian, else a quiet icon. It opens what it follows in the
 * side pane's Following tab, or in a full-height sheet where the pane would
 * take the whole width.
 */
export function ConciergeFollowingPill() {
  const { t } = useTranslation("chat");
  const pane = useToolFollowing();
  const { followCount } = useConciergeFollowing();
  const count = followCount;
  const [sheetOpen, setSheetOpen] = useState(false);

  // The tab belongs to this chat: it goes when the chat does.
  const hide = pane?.hide;
  useEffect(() => () => hide?.(), [hide]);

  const open = () => {
    if (!pane || pane.compact) setSheetOpen(true);
    else if (pane.active) pane.hide();
    else pane.show();
  };
  const label =
    count > 0 ? t("concierge.following.pill", { count }) : t("concierge.following.pillIdle");
  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={label}
        title={label}
        aria-expanded={pane && !pane.compact ? pane.active : undefined}
        data-concierge-following-pill
        // The same pill as Tasks: a small inline count, with the 44px touch
        // floor as the `before:` hit area around it.
        className={cn(
          "relative inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full text-aux tabular-nums outline-1 outline-offset-0 outline-transparent transition-colors before:absolute before:-inset-2 focus-visible:outline-solid focus-visible:outline-ring/50",
          count > 0
            ? "bg-surface-muted px-2 text-muted-foreground hover:bg-muted aria-expanded:bg-muted"
            : "w-6 text-subtle-foreground hover:text-foreground",
        )}
      >
        <BellRing className="size-3" aria-hidden />
        {count > 0 ? count : null}
      </button>
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        ariaLabel={t("concierge.following.title")}
        widthClassName="w-full max-w-none"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
          <SheetTitle className="flex-1 truncate text-title text-foreground">
            {t("concierge.following.title")}
          </SheetTitle>
          <IconButton
            size="sm"
            label={t("concierge.following.close")}
            icon={<X />}
            onClick={() => setSheetOpen(false)}
          />
        </div>
        <div className="min-h-0 flex-1">
          <ConciergeFollowingPanel />
        </div>
      </Sheet>
    </>
  );
}
