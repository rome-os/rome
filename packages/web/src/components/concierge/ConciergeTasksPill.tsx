import { ListChecks, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useToolTasks } from "@/pages/free/tool-tasks";
import { ConciergeTaskPanel } from "./ConciergeTaskPanel";
import { pillState } from "./tasks";
import { useConciergeTasks } from "./use-concierge-tasks";

/**
 * The Concierge chat's header pill, beside its name: the number of tasks that
 * need the guardian in warning colour, else the number in progress, else a
 * quiet icon. It opens the task list in the side pane's Tasks tab, or in a
 * full-height sheet where the pane would take the whole width.
 */
export function ConciergeTasksPill() {
  const { t } = useTranslation("chat");
  const pane = useToolTasks();
  const { tasks } = useConciergeTasks();
  const state = pillState(tasks);
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
    state.kind === "needsYou"
      ? t("concierge.tasks.pill.needsYou", { count: state.count })
      : state.kind === "doing"
        ? t("concierge.tasks.pill.doing", { count: state.count })
        : t("concierge.tasks.pill.idle");
  return (
    <>
      <button
        type="button"
        onClick={open}
        aria-label={label}
        title={label}
        aria-expanded={pane && !pane.compact ? pane.active : undefined}
        data-concierge-tasks-pill
        data-state={state.kind}
        // A small inline count on every screen. The 44px touch floor is the
        // `before:` hit area around it, so the pill stays out of the name's way.
        className={cn(
          "relative inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-full text-aux tabular-nums outline-1 outline-offset-0 outline-transparent transition-colors before:absolute before:-inset-2 focus-visible:outline-solid focus-visible:outline-ring/50",
          state.kind === "needsYou" &&
            "bg-warning-bg px-2 text-warning-fg hover:bg-warning-bg/80 aria-expanded:bg-warning-bg/80",
          state.kind === "doing" &&
            "bg-surface-muted px-2 text-muted-foreground hover:bg-muted aria-expanded:bg-muted",
          state.kind === "idle" && "w-6 text-subtle-foreground hover:text-foreground",
        )}
      >
        <ListChecks className="size-3" aria-hidden />
        {state.kind === "idle" ? null : state.count}
      </button>
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        ariaLabel={t("concierge.tasks.title")}
        widthClassName="w-full max-w-none"
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
          <SheetTitle className="flex-1 truncate text-title text-foreground">
            {t("concierge.tasks.title")}
          </SheetTitle>
          <IconButton
            size="sm"
            label={t("concierge.tasks.close")}
            icon={<X />}
            onClick={() => setSheetOpen(false)}
          />
        </div>
        <div className="min-h-0 flex-1">
          <ConciergeTaskPanel onNavigate={() => setSheetOpen(false)} />
        </div>
      </Sheet>
    </>
  );
}
