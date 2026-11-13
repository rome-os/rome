import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { useToolTasks } from "@/pages/free/tool-tasks";
import { TaskList } from "./TaskList";

/**
 * Opens a Concierge chat's task list: in the side pane's Tasks tab, or in a
 * full-height sheet where the pane would take the whole width. Render `sheet`
 * once, outside any menu, so it outlives what opened it.
 */
export function useTaskList(chatId: string | null) {
  const { t } = useTranslation("chat");
  const pane = useToolTasks();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The tab belongs to this chat: it goes when the chat does.
  const hide = pane?.hide;
  useEffect(() => () => hide?.(), [hide]);

  const open = () => {
    if (!chatId) return;
    if (!pane || pane.compact) setSheetOpen(true);
    else pane.show(chatId);
  };
  const close = () => setSheetOpen(false);
  const sheet = chatId ? (
    <Sheet
      open={sheetOpen}
      onClose={close}
      ariaLabel={t("concierge.taskList.title")}
      widthClassName="w-full max-w-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
        <SheetTitle className="flex-1 truncate text-title text-foreground">
          {t("concierge.taskList.title")}
        </SheetTitle>
        <IconButton size="sm" label={t("concierge.taskList.close")} icon={<X />} onClick={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-safe">
        <TaskList chatId={chatId} onNavigate={close} />
      </div>
    </Sheet>
  ) : null;
  return { open, sheet };
}
