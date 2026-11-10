import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { useToolTasks } from "@/pages/free/tool-tasks";
import { ConciergeTaskPanel } from "./ConciergeTaskPanel";

/**
 * Opens a Concierge chat's task list: in the side pane's Tasks tab, or in a
 * full-height sheet where the pane would take the whole width. Render `sheet`
 * once, outside any menu, so it outlives the menu that opened it.
 */
export function useConciergeTaskList(chatId: string | null) {
  const { t } = useTranslation("chat");
  const pane = useToolTasks();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The tab belongs to this chat: it goes when the chat does.
  const hide = pane?.hide;
  useEffect(() => () => hide?.(), [hide]);

  const open = () => {
    if (!pane || pane.compact) setSheetOpen(true);
    else pane.show();
  };
  const sheet = (
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
        <ConciergeTaskPanel chatId={chatId} onNavigate={() => setSheetOpen(false)} />
      </div>
    </Sheet>
  );
  return { open, sheet };
}
