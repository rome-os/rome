import { Dialog, DialogTitle } from "@/components/ui/dialog";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { SettingsBackContext } from "@/hooks/use-settings-back";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import { X } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { normalizeTab, TABS, tabToSlug } from "./SettingsTabPage";

/**
 * Settings, over the page the guardian came from: a menu of its sections beside
 * the section itself. Every `/settings` address opens here, so links and OAuth
 * returns need no change. `onClose` leaves Settings.
 */
export default function SettingsDialog({
  onClose: close,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation("settings");
  const { pathname } = useLocation();
  const activeSlug = pathname.split("/")[2] ?? tabToSlug(TABS[0]);
  // Focus starts on the section, so nothing wears a ring until the keyboard moves.
  const section = useRef<HTMLDivElement>(null);
  const back = useRef<(() => void)[]>([]);
  const activeTab = normalizeTab(activeSlug);
  useDocumentTitle([activeTab ? t(`tabs.${activeTab}` as const) : null, t("page.title")], "dialog");

  return (
    <Dialog
      open
      onClose={close}
      size="lg"
      initialFocusRef={section}
      // Spread, since the kit's prop list leaves this out: in a drilled-in view,
      // Escape steps back one level rather than leaving Settings.
      {...{
        onEscapeKeyDown: (event: Event) => {
          const step = back.current.at(-1);
          if (!step) return;
          event.preventDefault();
          step();
        },
      }}
      className="flex h-[min(760px,calc(100dvh-2rem))] max-w-[960px] flex-col overflow-hidden p-0 max-sm:h-dvh max-sm:rounded-none sm:w-[calc(100vw-2rem)] sm:flex-row"
    >
      <div className="flex shrink-0 flex-col gap-3 border-border p-3 max-sm:border-b sm:w-52 sm:border-r">
        <DialogTitle className="px-2 pt-1 text-section">{t("page.title")}</DialogTitle>
        <nav aria-label={t("page.title")} className="overflow-x-auto">
          <ul className="flex gap-1 sm:flex-col">
            {TABS.map((tab) => {
              const slug = tabToSlug(tab);
              const active = slug === activeSlug;
              return (
                <li key={tab}>
                  <Link
                    to={`/settings/${slug}`}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center rounded-8 px-2 text-ui whitespace-nowrap transition-colors duration-150",
                      active
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    {t(`tabs.${tab}` as const)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
      <div
        ref={section}
        tabIndex={-1}
        className="relative min-h-0 min-w-0 flex-1 overflow-y-auto bg-background outline-none"
      >
        <SettingsBackContext.Provider value={back}>{children}</SettingsBackContext.Provider>
      </div>
      <IconButton
        label={t("common.close")}
        size="sm"
        className="absolute top-3 right-3"
        onClick={close}
        icon={<X aria-hidden />}
      />
    </Dialog>
  );
}
