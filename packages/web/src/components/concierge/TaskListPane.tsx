import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { useToolTasks } from "@/pages/free/tool-tasks";
import { TaskList, type TaskListView } from "./TaskList";

/**
 * Opens a Concierge chat's tasks or routines: in the side pane's tab, or in a
 * full-height sheet where the pane would take the whole width. Render `sheet`
 * once, outside any menu, so it outlives what opened it.
 */
export function useTaskList(chatId: string | null) {
  const { t } = useTranslation("chat");
  const pane = useToolTasks();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetView, setSheetView] = useState<TaskListView>("tasks");

  // The tab belongs to this chat: it goes when the chat does.
  const hide = pane?.hide;
  useEffect(() => () => hide?.(), [hide]);

  const open = (view: TaskListView = "tasks") => {
    if (!chatId) return;
    if (!pane || pane.compact) {
      setSheetView(view);
      setSheetOpen(true);
    } else pane.show(chatId, view);
  };
  const close = () => setSheetOpen(false);
  const title =
    sheetView === "routines" ? t("concierge.taskList.routines") : t("concierge.taskList.title");
  const sheet = chatId ? (
    <Sheet open={sheetOpen} onClose={close} ariaLabel={title} widthClassName="w-full max-w-none">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
        <SheetTitle className="flex-1 truncate text-title text-foreground">{title}</SheetTitle>
        <IconButton size="sm" label={t("concierge.taskList.close")} icon={<X />} onClick={close} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-safe">
        <TaskList chatId={chatId} view={sheetView} onNavigate={close} />
      </div>
    </Sheet>
  ) : null;
  return { open, sheet, sheetOpen };
}
