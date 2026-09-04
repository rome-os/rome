import { Cross1Icon, HamburgerMenuIcon } from "@radix-ui/react-icons";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { UpgradeCountdownBanner } from "../components/upgrade-countdown-banner";
import { IconButton } from "../components/ui/icon-button";
import { MobileBackdrop } from "../components/ui/mobile-backdrop";
import { SlotOutlet } from "../components/slot";
import { AppGrid } from "./AppGrid";
import { ChatSearchDialog } from "./ChatSearchDialog";
import { ProfileMenu } from "./ProfileMenu";
import { RecentChats } from "./RecentChats";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { saveSetting } from "@/lib/chat-api";
import { useDesktop } from "@/hooks/use-desktop";
import { useSettings } from "@/hooks/use-settings";

const GUARDIAN_LANGUAGE_SETTING_KEY = "guardianLanguage";
const SIDEBAR_COLLAPSED_KEY = "rome-sidebar-collapsed";

const isSupportedLanguage = (lng: string | undefined): lng is string =>
  !!lng && (SUPPORTED_LANGUAGES as readonly string[]).includes(lng);

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function sidebarShortcutForPlatform(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return /Mac|iPhone|iPad|iPod/i.test(platform) ? "⌘B" : "Ctrl B";
}

export function RomeShellLayout() {
  const { t, i18n } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [appGridControlsHost, setAppGridControlsHost] = useState<HTMLDivElement | null>(null);
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";
  const isDesktop = useDesktop();
  // The rail is a desktop arrangement: below `md` the sidebar is a slide-over
  // that should always open at full width, so a collapse saved on desktop
  // must not shrink the mobile drawer.
  const railMode = collapsed && isDesktop;
  const sidebarShortcut = sidebarShortcutForPlatform();

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    setSidebarOpen(false);
    setChatSearchOpen(false);
  }, [location.pathname]);

  // Keep the dashboard language and the backend `guardianLanguage` setting in
  // sync so server-generated channel notices (e.g. the "no AI tool configured"
  // nudge) match what the guardian sees here.
  //
  // Backend is the cross-device source of truth: i18n only reads localStorage,
  // so a fresh browser/device falls back to `en`. We hydrate the UI from the
  // stored setting once on load, then persist *only* on explicit user changes.
  // We never write on mount — doing so would clobber a preference set on another
  // device with this browser's localStorage fallback.
  const { data: settings, isSuccess: settingsLoaded } = useSettings();
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current || !settingsLoaded || !settings) return;
    hydratedRef.current = true;
    const stored = settings[GUARDIAN_LANGUAGE_SETTING_KEY];
    if (typeof stored === "string" && isSupportedLanguage(stored)) {
      // Backend has a preference — it's the source of truth, so hydrate the UI
      // from it (never overwrite it on mount).
      if (stored !== i18n.resolvedLanguage) void i18n.changeLanguage(stored);
    } else if (!Object.prototype.hasOwnProperty.call(settings, GUARDIAN_LANGUAGE_SETTING_KEY)) {
      // No stored preference yet — backfill once from the current UI language so
      // external-channel notices match without waiting for an explicit toggle.
      // Safe: only writes when the backend row is absent, so it can't clobber a
      // preference set on another device.
      const current = i18n.resolvedLanguage ?? i18n.language;
      if (isSupportedLanguage(current)) void saveSetting(GUARDIAN_LANGUAGE_SETTING_KEY, current);
    }
  }, [settings, settingsLoaded, i18n]);

  useEffect(() => {
    const persist = (lng: string) => {
      if (isSupportedLanguage(lng)) void saveSetting(GUARDIAN_LANGUAGE_SETTING_KEY, lng);
    };
    i18n.on("languageChanged", persist);
    return () => i18n.off("languageChanged", persist);
  }, [i18n]);

  // The `rome:host-navigate` bridge (SDK `navigateRome`/`startChat`) is mounted
  // once at the app root via `useHostNavigation` (see App.tsx), so it covers the
  // shell and full-mode app pages alike — no per-layout listener here.

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const modifier = isMac ? event.metaKey : event.ctrlKey;
      if (modifier && event.shiftKey && event.key.toLowerCase() === "o") {
        event.preventDefault();
        navigate(hideSidebar ? "/chat?hideSidebar=1" : "/chat");
      }
      if (
        modifier &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "b" &&
        !hideSidebar
      ) {
        event.preventDefault();
        toggleCollapsed();
      }
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hideSidebar, navigate, toggleCollapsed]);

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <UpgradeCountdownBanner />
      <div className="relative flex flex-1">
        {sidebarOpen && !hideSidebar ? (
          <MobileBackdrop label={t("nav.closeSidebar")} onDismiss={() => setSidebarOpen(false)} />
        ) : null}
        {!hideSidebar ? (
          <aside
            className={`fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-border bg-background pb-safe pt-safe transition-[transform,width] duration-200 ease-out md:sticky md:top-0 md:h-dvh md:translate-x-0 md:pb-0 md:pt-0 ${
              railMode ? "md:w-16" : ""
            } ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}
          >
            {railMode ? (
              <div data-app-titlebar="header" className="flex shrink-0 justify-center pb-4 pt-5">
                {/* The logo doubles as the expand control: hover or keyboard
                    focus crossfades it into the panel glyph so the rail spends
                    one tile, not two, on chrome. Home stays reachable through
                    the wordmark once the sidebar is expanded. */}
                <IconButton
                  size="md"
                  label={t("nav.expandSidebar")}
                  title={t("nav.expandSidebarShortcut", { shortcut: sidebarShortcut })}
                  onClick={toggleCollapsed}
                  className="group relative"
                  icon={
                    <>
                      <img
                        src="/icon.svg"
                        alt=""
                        aria-hidden
                        className="h-5 w-5 transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0"
                      />
                      <PanelLeftOpen
                        aria-hidden
                        className="absolute inset-0 m-auto size-4 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                      />
                    </>
                  }
                />
              </div>
            ) : (
              <div
                data-app-titlebar="header"
                className="flex shrink-0 items-center justify-between px-5 pb-4 pt-5"
              >
                <Link to="/" className="text-title text-foreground">
                  {t("appName")}
                </Link>
                <div className="flex items-center gap-1">
                  <div ref={setAppGridControlsHost} />
                  <IconButton
                    size="md"
                    label={t("nav.collapseSidebar")}
                    title={t("nav.collapseSidebarShortcut", { shortcut: sidebarShortcut })}
                    icon={<PanelLeftClose aria-hidden />}
                    onClick={toggleCollapsed}
                    className="hidden text-subtle-foreground hover:text-foreground md:inline-flex"
                  />
                  <IconButton
                    size="md"
                    label={t("nav.closeSidebar")}
                    icon={<Cross1Icon aria-hidden />}
                    onClick={() => setSidebarOpen(false)}
                    className="text-subtle-foreground hover:text-foreground md:hidden"
                  />
                </div>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-idle-hidden">
              {railMode ? (
                <AppGrid collapsed onSearch={() => setChatSearchOpen(true)} />
              ) : (
                <>
                  <AppGrid headerControlsHost={appGridControlsHost} />
                  <RecentChats onSearch={() => setChatSearchOpen(true)} />
                </>
              )}
            </div>
            <div
              className={`flex shrink-0 items-center py-3 ${railMode ? "justify-center" : "px-4"}`}
            >
              <ProfileMenu />
            </div>
          </aside>
        ) : null}
        <ChatSearchDialog open={chatSearchOpen} onOpenChange={setChatSearchOpen} />
        {/* The in-flow sidebar pushes routed content right by its own width on
            desktop — 16rem expanded, 4rem as the collapsed rail — and with
            ?hideSidebar=1 there's no sidebar and content starts at the viewport
            edge. Publish that left offset so a `fixed` child like the trace
            drawer can align to the chat column. The public share tree has no
            shell, so its drawer falls back to 0px. */}
        <main
          className="flex min-w-0 flex-1 flex-col bg-background"
          style={
            {
              "--rome-chat-left": hideSidebar ? "0px" : railMode ? "4rem" : "16rem",
            } as CSSProperties
          }
        >
          <div data-app-titlebar="strip" aria-hidden />
          {!hideSidebar ? (
            <header
              data-app-titlebar="header"
              className="sticky top-0 z-10 flex h-[var(--rome-mobile-header-height)] shrink-0 items-center gap-2 border-b border-border bg-background px-2 pt-safe md:hidden"
            >
              <IconButton
                size="md"
                label={t("nav.openSidebar")}
                icon={<HamburgerMenuIcon aria-hidden />}
                onClick={() => setSidebarOpen(true)}
              />
              {/* The chat page fills this with the session's identity + app
                  tabs + actions, mirroring the desktop chat navbar. Other routes
                  leave it empty, so the Rome wordmark fallback shows. */}
              <SlotOutlet
                name="mobileHeader"
                className="flex min-w-0 flex-1 items-center gap-2"
                fallback={
                  <Link to="/" className="flex items-center gap-2">
                    <img src="/icon.svg" alt="" aria-hidden className="h-5 w-5" />
                    <span className="text-ui text-foreground">{t("appName")}</span>
                  </Link>
                }
              />
            </header>
          ) : null}
          {/* Height floor, not just flow: routed pages are lazy() behind a
              null Suspense fallback, so without it main collapses to zero for
              the frame between navigating and the chunk arriving. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
