import { AppWindow, Bell, HeartPulse, Mail, Search, Sun, type LucideIcon, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Sheet, SheetTitle } from "@/components/ui/sheet";
import { useConciergeName } from "@/hooks/use-concierge";
import { useToolAgent } from "@/pages/free/tool-agent";
import { RomeMascot } from "./RomeMascot";
import { WorkTab } from "./WorkTab";

type AgentTab = "work" | "uses";

/** The Uses tab's rows: a glyph and a short title. A press puts the prompt in the message box, unsent. */
const USES: ReadonlyArray<{ key: string; icon: LucideIcon }> = [
  { key: "brief", icon: Sun },
  { key: "price", icon: Bell },
  { key: "urgent", icon: Mail },
  { key: "app", icon: AppWindow },
  { key: "sleep", icon: HeartPulse },
  { key: "research", icon: Search },
];

function UsesTab({ onUse }: { onUse: (prompt: string) => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="px-4 pb-6 pt-1">
      <ul className="divide-y divide-border overflow-hidden rounded-12 border border-border bg-surface">
        {USES.map(({ key, icon: Icon }) => (
          <li key={key}>
            <button
              type="button"
              onClick={() => onUse(t(`concierge.agent.uses.${key}.prompt`))}
              className="flex min-h-12 w-full items-center gap-3 px-3 py-2 text-left outline-none outline-1 -outline-offset-1 outline-transparent transition-colors hover:bg-surface-hover focus-visible:outline-solid focus-visible:outline-ring/50"
            >
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-ui text-foreground">
                {t(`concierge.agent.uses.${key}.title`)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A Concierge chat's Agent page, laid out as the iOS app's: a close button at
 * the top left, the agent large and centred with its name under it, then
 * two tabs. Work, selected first, lists what runs for this chat. Uses offers
 * things to ask, and a press puts one in the chat's message box.
 */
export function AgentPage({
  chatId,
  onUse,
  onClose,
  onNavigate,
}: {
  chatId: string;
  onUse: (prompt: string) => void;
  onClose: () => void;
  /** Called before a row takes the guardian elsewhere, so a covering sheet can close. */
  onNavigate?: () => void;
}) {
  const { t } = useTranslation("chat");
  const name = useConciergeName();
  const [tab, setTab] = useState<AgentTab>("work");
  return (
    <div
      data-agent-page
      className="relative flex h-full flex-col overflow-y-auto bg-background pb-safe"
    >
      <IconButton
        size="md"
        label={t("concierge.agent.close")}
        icon={<X />}
        onClick={onClose}
        className="absolute left-3 top-3 text-muted-foreground hover:text-foreground"
      />
      <div className="mx-auto flex w-full max-w-xl flex-col">
        <header className="flex flex-col items-center gap-3 px-4 pt-14">
          <div className="flex size-24 items-center justify-center rounded-full border border-border bg-surface shadow-1">
            <RomeMascot className="h-14 w-auto" />
          </div>
          <h2 className="max-w-full truncate text-title font-semibold text-foreground">{name}</h2>
        </header>
        <div className="flex justify-center px-4 pb-3 pt-4">
          <SegmentedControl
            aria-label={t("concierge.agent.tabsLabel")}
            value={tab}
            onValueChange={(value) => setTab(value as AgentTab)}
            options={[
              { value: "work", label: t("concierge.agent.tabs.work") },
              { value: "uses", label: t("concierge.agent.tabs.uses") },
            ]}
            className="w-full max-w-80"
          />
        </div>
        {tab === "work" ? (
          <WorkTab chatId={chatId} onNavigate={onNavigate} />
        ) : (
          <UsesTab onUse={onUse} />
        )}
      </div>
    </div>
  );
}

/**
 * Opens a Concierge chat's Agent page: in the side pane's Agent tab, or in a
 * full-height sheet where the pane would take the whole width. Render `sheet`
 * once, outside any menu, so it outlives what opened it.
 */
export function useAgentPage(chatId: string | null, onUse: (prompt: string) => void) {
  const { t } = useTranslation("chat");
  const pane = useToolAgent();
  const [sheetOpen, setSheetOpen] = useState(false);

  // The tab belongs to this chat: it goes when the chat does.
  const hide = pane?.hide;
  useEffect(() => () => hide?.(), [hide]);

  const open = () => {
    if (!chatId) return;
    if (!pane || pane.compact) setSheetOpen(true);
    else pane.show({ chatId, onUse });
  };
  const close = () => setSheetOpen(false);
  const sheet = chatId ? (
    <Sheet
      open={sheetOpen}
      onClose={close}
      ariaLabel={t("concierge.agent.title")}
      widthClassName="w-full max-w-none"
    >
      <SheetTitle className="sr-only">{t("concierge.agent.title")}</SheetTitle>
      <div className="min-h-0 flex-1 pt-safe">
        <AgentPage
          chatId={chatId}
          onClose={close}
          onNavigate={close}
          onUse={(prompt) => {
            close();
            onUse(prompt);
          }}
        />
      </div>
    </Sheet>
  ) : null;
  return { open, sheet };
}
