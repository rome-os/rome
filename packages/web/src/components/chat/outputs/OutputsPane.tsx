import { X } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { type OutputsTabOptions, useToolOutputs } from "@/pages/free/tool-outputs";
import { type LeaveGuard, leaveEditor } from "./OutputEditor";
import { OutputsPanel } from "./OutputsPanel";

/**
 * Opens a chat's outputs: in the side pane's Outputs tab, or in a full-height
 * sheet where the pane would take the whole width. Render `sheet` once,
 * outside any menu, so it outlives what opened it.
 */
export function useOutputsPane(chatId: string | null, options: OutputsTabOptions = {}) {
  const { t } = useTranslation("chat");
  const pane = useToolOutputs();
  const [sheet, setSheet] = useState<{ outputId: string | null; seq: number } | null>(null);

  // The tab belongs to this chat: it goes when the chat does.
  const hide = pane?.hide;
  useEffect(() => () => hide?.(), [hide]);

  const open = (outputId?: string) => {
    if (!chatId) return;
    if (!pane || pane.compact) {
      setSheet((prev) => ({ outputId: outputId ?? null, seq: (prev?.seq ?? 0) + 1 }));
    } else pane.show(chatId, outputId, options);
  };
  // Closing the sheet first settles a file being edited in it.
  const leaveGuard: LeaveGuard = useRef(null);
  const closeNow = () => setSheet(null);
  const close = () => leaveEditor(leaveGuard, closeNow);
  const sheetElement = chatId ? (
    <Sheet
      open={sheet !== null}
      onClose={close}
      ariaLabel={t("outputs.title")}
      widthClassName="w-full max-w-none"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 pt-safe">
        <SheetTitle className="flex-1 truncate text-title text-foreground">
          {t("outputs.title")}
        </SheetTitle>
        <IconButton size="sm" label={t("outputs.close")} icon={<X />} onClick={close} />
      </div>
      {/* The sheet's surface, which a scrolling row's edge fades from. */}
      <div
        className="min-h-0 flex-1"
        style={{ "--scroll-edge-bg": "var(--color-surface)" } as CSSProperties}
      >
        <OutputsPanel
          chatId={chatId}
          selectedId={sheet?.outputId ?? null}
          selectionSeq={sheet?.seq}
          onNavigate={closeNow}
          leaveGuard={leaveGuard}
          heading={false}
          taskChats={options.taskChats}
        />
      </div>
    </Sheet>
  ) : null;
  return { open, sheet: sheetElement, sheetOpen: sheet !== null };
}
