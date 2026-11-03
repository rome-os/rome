import { ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { SlotOutlet } from "../components/slot";
import { IconButton } from "../components/ui/icon-button";
import { useHistoryNav } from "./use-history-nav";
import { isApplePlatform } from "@/lib/platform";

/** The slot a page fills to put its own bar into the title bar. */
export const TITLEBAR_SLOT = "titlebar";
/**
 * The title bar's trailing slot, for the header of a panel that runs down the
 * window's right edge. Its filler sets its own width to the panel's.
 */
export const TITLEBAR_END_SLOT = "titlebarEnd";

/**
 * The Mac app's title bar: one row across the top of the window that holds the
 * traffic lights, the sidebar toggle, and back and forward, since the window
 * has no browser toolbar. To its right is the page's own bar, which a page
 * moves in through {@link TITLEBAR_SLOT} instead of drawing a second row.
 *
 * The bar draws no line of its own: the content box under it carries the
 * edge. The leading group is at least as wide as the sidebar, so the page's
 * bar starts over the page and not over the chat list. Back and forward lead it
 * because they are always there; the toggle follows them, since only Chat has
 * a list to collapse, and leading with it would shift both arrows on every
 * other page.
 */
export function DesktopTitlebar({
  leadingWidth,
  sidebarToggle,
}: {
  /** Where the page starts, as a CSS length. */
  leadingWidth: string;
  sidebarToggle?: ReactNode;
}) {
  const { t } = useTranslation("common");
  const { canGoBack, canGoForward, back, forward } = useHistoryNav();
  const apple = isApplePlatform(navigator.platform);
  const backShortcut = apple ? "⌘[" : "Alt ←";
  const forwardShortcut = apple ? "⌘]" : "Alt →";

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const step = apple
        ? event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
          ? { "[": -1, "]": 1 }[event.key]
          : undefined
        : event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey
          ? { ArrowLeft: -1, ArrowRight: 1 }[event.key]
          : undefined;
      if (step === undefined) return;
      event.preventDefault();
      if (step < 0 && canGoBack) back();
      if (step > 0 && canGoForward) forward();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [apple, back, canGoBack, canGoForward, forward]);

  return (
    <div data-app-titlebar="bar" className="flex h-12 shrink-0 items-center">
      {/* The traffic lights sit in the first 5rem on a Mac; the window
          positions them, so this only keeps the buttons clear of them. */}
      <div
        className={`flex shrink-0 items-center gap-1 ${apple ? "pl-20" : "pl-3"}`}
        style={{ minWidth: leadingWidth }}
      >
        <IconButton
          size="sm"
          label={t("nav.back")}
          title={t("nav.backShortcut", { shortcut: backShortcut })}
          icon={<ChevronLeft aria-hidden />}
          onClick={back}
          disabled={!canGoBack}
          className="text-subtle-foreground hover:text-foreground disabled:hover:bg-transparent"
        />
        <IconButton
          size="sm"
          label={t("nav.forward")}
          title={t("nav.forwardShortcut", { shortcut: forwardShortcut })}
          icon={<ChevronRight aria-hidden />}
          onClick={forward}
          disabled={!canGoForward}
          className="text-subtle-foreground hover:text-foreground disabled:hover:bg-transparent"
        />
        {sidebarToggle}
      </div>
      {/* Clipped, because a page can leave its bar no room: a panel at full
          width takes the whole row while the chat it covers stays mounted. */}
      <SlotOutlet
        name={TITLEBAR_SLOT}
        className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden pl-4 pr-2"
      />
      <SlotOutlet name={TITLEBAR_END_SLOT} className="flex h-full shrink-0" />
    </div>
  );
}
