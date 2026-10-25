import { HamburgerMenuIcon } from "@radix-ui/react-icons";
import {
  ChevronLeft,
  ChevronsLeft,
  ChevronsRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { UpgradeCountdownBanner } from "../components/upgrade-countdown-banner";
import { IconButton } from "../components/ui/icon-button";
import { MobileBackdrop } from "../components/ui/mobile-backdrop";
import { SlotOutlet } from "../components/slot";
import { SLIDE_MS, useSwipeSidebar } from "./use-swipe-sidebar";
import { AppGrid } from "./AppGrid";
import { APP_NAV } from "./builtin-nav";
import { ChatSearchDialog } from "./ChatSearchDialog";
import { DesktopTitlebar } from "./DesktopTitlebar";
import { ProfileMenu } from "./ProfileMenu";
import { RecentChats } from "./RecentChats";
import { RailLabelsContext } from "./sidebar-shared";
import { useChatPeek } from "./use-chat-peek";
import { SUPPORTED_LANGUAGES } from "@/i18n";
import { saveSetting } from "@/lib/chat-api";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useDesktop } from "@/hooks/use-desktop";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useSettings } from "@/hooks/use-settings";
import { isElectronShell } from "@/lib/electron-shell";
import { routeTitle } from "@/lib/page-title";
import { isApplePlatform } from "@/lib/platform";

const GUARDIAN_LANGUAGE_SETTING_KEY = "guardianLanguage";
const SIDEBAR_COLLAPSED_KEY = "rome-sidebar-collapsed";
const RAIL_NAMES_KEY = "rome-sidebar-names";
/** The rail's width in rem: names beside the icons, or icons alone. */
const RAIL_NAMED_REM = 12;
const RAIL_BARE_REM = 4;
/** The chat column's width in rem. */
const CHATS_REM = 16;
/** Travel along the rail's edge that switches the names, so a drag snaps to
 *  one of the two widths instead of resizing freely. */
const EDGE_SNAP_PX = 24;
/** Travel under which a press on the edge counts as a click. */
const EDGE_CLICK_PX = 3;

const isSupportedLanguage = (lng: string | undefined): lng is string =>
  !!lng && (SUPPORTED_LANGUAGES as readonly string[]).includes(lng);

function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

// Names show until the guardian hides them, so a first visit reads the rail
// instead of guessing at its icons.
function readRailNames(): boolean {
  try {
    return localStorage.getItem(RAIL_NAMES_KEY) !== "0";
  } catch {
    return true;
  }
}

function sidebarShortcutForPlatform(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return isApplePlatform(platform) ? "⌘B" : "Ctrl B";
}

export function RomeShellLayout() {
  const { t, i18n } = useTranslation("common");
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // On a phone the chat list is a full-screen layer over the Chat page, not a
  // drawer column: the master of a master-detail pair whose detail is the
  // chat. It is UI state, not a route, so `/chat` still means a new chat.
  const [chatListOpen, setChatListOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed);
  const [railNames, setRailNames] = useState(readRailNames);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const hideSidebar = new URLSearchParams(location.search).get("hideSidebar") === "1";
  const isDesktop = useDesktop();
  // The fallback title for whatever the shell is showing. A routed page that
  // can name its own subject claims the page slot, which outranks this.
  // Sourced from the sidebar's own destinations: the nav already has to know
  // what each route is called, so the title has no list of its own to drift from.
  const route = routeTitle(location.pathname, APP_NAV);
  useDocumentTitle(route === null ? null : [route.detail, t(route.key)], "route");
  // The sidebar has two columns: the rail of Rome's surfaces and pinned apps,
  // always there, and the chat list, which belongs to Chat alone. Collapsing
  // hides the chat list. That is a desktop arrangement: below `md` the sidebar
  // is a slide-over, so a collapse saved on desktop must not empty the drawer.
  const onChat = location.pathname === "/chat" || location.pathname.startsWith("/chat/");
  const showChats = isDesktop && onChat && !collapsed;
  const phoneChatList = !isDesktop && onChat && chatListOpen && !hideSidebar;
  const sidebarShortcut = sidebarShortcutForPlatform();
  const railRem = railNames ? RAIL_NAMED_REM : RAIL_BARE_REM;
  const sidebarWidth = hideSidebar ? "0px" : `${railRem + (showChats ? CHATS_REM : 0)}rem`;
  // The Mac app has no browser toolbar, so it gets a title bar of its own. The
  // sidebar toggle moves there from the chat list and the logo.
  const [titlebar] = useState(isElectronShell);
  // The collapsed list can be peeked at by hover, so only where there is one.
  const coarsePointer = useCoarsePointer();
  const canPeek = onChat && !showChats && isDesktop && !coarsePointer && !hideSidebar;
  const peekRef = useRef<HTMLDivElement>(null);
  const chatPeek = useChatPeek(canPeek, location.pathname, peekRef);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {}
      return next;
    });
  }, []);

  const setRailNamesPersisted = useCallback((next: boolean) => {
    setRailNames(next);
    try {
      localStorage.setItem(RAIL_NAMES_KEY, next ? "1" : "0");
    } catch {}
  }, []);

  // The rail's right edge switches the names. A click flips them; a drag
  // snaps once it has travelled far enough toward the other width, so the
  // rail is only ever one of its two widths.
  const edgeDrag = useRef<{ x: number; moved: boolean } | null>(null);
  const onEdgePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    edgeDrag.current = { x: event.clientX, moved: false };
  };
  const onEdgePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = edgeDrag.current;
    if (!drag) return;
    const dx = event.clientX - drag.x;
    if (Math.abs(dx) > EDGE_CLICK_PX) drag.moved = true;
    if (railNames && dx < -EDGE_SNAP_PX) {
      setRailNamesPersisted(false);
      drag.x = event.clientX;
    } else if (!railNames && dx > EDGE_SNAP_PX) {
      setRailNamesPersisted(true);
      drag.x = event.clientX;
    }
  };
  const onEdgePointerUp = () => {
    const drag = edgeDrag.current;
    edgeDrag.current = null;
    if (drag && !drag.moved) setRailNamesPersisted(!railNames);
  };

  useEffect(() => {
    setSidebarOpen(false);
    setChatSearchOpen(false);
  }, [location.pathname]);

  // Any navigation closes the phone chat list: picking a chat, New chat, or
  // New chat in a folder all land somewhere, even New chat on `/chat` itself,
  // which changes the location's key.
  useEffect(() => {
    setChatListOpen(false);
  }, [location.key]);

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

  // On a phone a swipe right anywhere opens the sidebar and a swipe left closes
  // it. The menu button in the mobile header stays as the visible way in.
  const sidebarRef = useRef<HTMLElement>(null);
  const pageRef = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  useSwipeSidebar({
    disabled: hideSidebar,
    open: sidebarOpen,
    setOpen: setSidebarOpen,
    sidebar: sidebarRef,
    page: pageRef,
    scrim: scrimRef,
    frame: frameRef,
  });
  // On a phone the open sidebar pushes the page right rather than covering
  // it. The clip keeps that push from scrolling the document sideways. It
  // holds while the page is pushed and until the page has slid back home, so
  // a page that overflows at rest still shows it.
  const pushed = sidebarOpen && !hideSidebar;
  const [clipped, setClipped] = useState(pushed);
  if (pushed && !clipped) setClipped(true);
  useEffect(() => {
    if (pushed || !clipped) return;
    const timer = window.setTimeout(() => setClipped(false), SLIDE_MS + 50);
    return () => window.clearTimeout(timer);
  }, [pushed, clipped]);

  // The rail, the chat list, and its peek: the browser layout and the Mac
  // app's arrange the same parts differently.
  const railNamesLabel = t(railNames ? "sidebar.hideNames" : "sidebar.showNames");
  const rail = (
    <div
      className="relative flex shrink-0 flex-col"
      style={{ width: `${railRem}rem` }}
      data-rail-labelled={railNames ? "" : undefined}
    >
      <div
        className={`flex shrink-0 items-center gap-1 pb-4 ${railNames ? "justify-start px-3" : "justify-center"} ${titlebar ? "pt-2" : "pt-5"}`}
      >
        {/* A fixed slot, so swapping the logo link for the 32px expand
            button does not move every tile below it. */}
        <div className="flex size-10 items-center justify-center">
          {onChat && !showChats && !titlebar && isDesktop ? (
            // With the chat list collapsed, the logo doubles as the
            // control that brings it back: hover or keyboard focus
            // crossfades it into the panel glyph.
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
          ) : (
            <Link
              to="/"
              aria-label={t("appName")}
              title={t("appName")}
              className="flex size-10 items-center justify-center rounded-8 outline-none outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
            >
              <img src="/icon.svg" alt="" aria-hidden className="h-5 w-5" />
            </Link>
          )}
        </div>
        {railNames ? (
          <span className="min-w-0 truncate text-ui font-medium text-foreground">
            {t("appName")}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-idle-hidden">
        <RailLabelsContext.Provider value={railNames}>
          <AppGrid
            onSearch={() => setChatSearchOpen(true)}
            chatPeek={canPeek ? chatPeek.tile : undefined}
          />
        </RailLabelsContext.Provider>
      </div>
      <div
        className={`flex shrink-0 py-3 ${railNames ? "items-center justify-between px-3" : "flex-col items-center gap-2"}`}
      >
        <IconButton
          size="sm"
          label={railNamesLabel}
          title={railNamesLabel}
          icon={railNames ? <ChevronsLeft aria-hidden /> : <ChevronsRight aria-hidden />}
          onClick={() => setRailNamesPersisted(!railNames)}
          className={`text-subtle-foreground hover:text-foreground ${railNames ? "order-last" : ""}`}
        />
        <ProfileMenu />
      </div>
      {isDesktop ? (
        // The edge itself, a few pixels either side of the rail's last one.
        // The button above is the named, focusable control; this is the
        // pointer shortcut onto the same switch. Not on a phone, where a
        // swipe across the edge closes the drawer.
        <div
          aria-hidden
          title={railNamesLabel}
          data-rail-edge
          onPointerDown={onEdgePointerDown}
          onPointerMove={onEdgePointerMove}
          onPointerUp={onEdgePointerUp}
          onPointerCancel={() => {
            edgeDrag.current = null;
          }}
          className="group absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none"
        >
          <div className="mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-border-strong" />
        </div>
      ) : null}
    </div>
  );
  const chatList = (
    <RecentChats
      belowTitlebar={titlebar}
      headerControls={
        titlebar ? null : (
          <IconButton
            size="sm"
            label={t("nav.collapseSidebar")}
            title={t("nav.collapseSidebarShortcut", { shortcut: sidebarShortcut })}
            icon={<PanelLeftClose aria-hidden />}
            onClick={toggleCollapsed}
            className="text-subtle-foreground hover:text-foreground"
          />
        )
      }
    />
  );
  const peekList = (
    <RecentChats
      belowTitlebar={titlebar}
      headerControls={
        <IconButton
          size="sm"
          label={t("nav.expandSidebar")}
          title={t("nav.expandSidebarShortcut", { shortcut: sidebarShortcut })}
          icon={<PanelLeftOpen aria-hidden />}
          onClick={toggleCollapsed}
          className="text-subtle-foreground hover:text-foreground"
        />
      }
    />
  );
  const searchDialog = <ChatSearchDialog open={chatSearchOpen} onOpenChange={setChatSearchOpen} />;
  // Height floor, not just flow: routed pages are lazy() behind a null
  // Suspense fallback, so without it the page collapses to zero for the frame
  // between navigating and the chunk arriving.
  const routed = (
    <div className="flex min-h-0 flex-1 flex-col">
      <Outlet />
    </div>
  );

  if (titlebar) {
    // The Mac app is three boxes, outside in. The window (A) draws the title
    // bar and the rail on one background. The content (B) sits in the corner
    // they leave, and its own top and left border is the only line between
    // the two, so the corner is one box's edge, not two lines meeting. The
    // page (C) scrolls inside B, so that edge never scrolls away. The corner is
    // rounded, and B clips what it holds to it.
    const contentLeft = hideSidebar ? "0px" : `calc(${sidebarWidth} + 1px)`;
    return (
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <UpgradeCountdownBanner />
        <DesktopTitlebar
          leadingWidth={contentLeft}
          sidebarToggle={
            onChat && !hideSidebar ? (
              <IconButton
                size="sm"
                label={t(showChats ? "nav.collapseSidebar" : "nav.expandSidebar")}
                title={t(showChats ? "nav.collapseSidebarShortcut" : "nav.expandSidebarShortcut", {
                  shortcut: sidebarShortcut,
                })}
                icon={showChats ? <PanelLeftClose aria-hidden /> : <PanelLeftOpen aria-hidden />}
                onClick={toggleCollapsed}
                className="text-subtle-foreground hover:text-foreground"
              />
            ) : null
          }
        />
        <div className="flex min-h-0 flex-1">
          {hideSidebar ? null : <aside className="flex min-h-0 shrink-0">{rail}</aside>}
          <div
            className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden border-t border-border ${hideSidebar ? "" : "rounded-tl-12 border-l"}`}
          >
            {showChats ? (
              <div className="flex w-64 min-w-0 shrink-0 flex-col border-r border-border">
                {chatList}
              </div>
            ) : null}
            {/* The collapsed chat list, shown over the page rather than beside
                it, so a glance does not reflow the chat. */}
            {chatPeek.open ? (
              <div
                ref={peekRef}
                data-chat-peek
                className="absolute inset-y-0 left-0 z-30 flex w-64 min-w-0 flex-col border-r border-border bg-background shadow-10"
              >
                {peekList}
              </div>
            ) : null}
            {/* A page sized to the screen gets what B leaves: the bar and B's
                top border. The trace drawer lines up with the chat column. */}
            <main
              className="flex min-w-0 flex-1 flex-col overflow-y-auto bg-background"
              style={
                {
                  "--rome-viewport-height": "calc(100dvh - 3rem - 1px)",
                  "--rome-chat-left": contentLeft,
                  "--rome-chat-top": "calc(3rem + 1px)",
                } as CSSProperties
              }
            >
              {routed}
            </main>
          </div>
        </div>
        {searchDialog}
      </div>
    );
  }

  return (
    <div className="flex min-h-[var(--rome-viewport-height)] flex-col bg-background">
      <UpgradeCountdownBanner />
      <div
        ref={frameRef}
        className={`relative flex flex-1 ${clipped ? "max-md:overflow-x-clip" : ""}`}
      >
        {!hideSidebar ? (
          <MobileBackdrop
            ref={scrimRef}
            open={sidebarOpen}
            label={t("nav.closeSidebar")}
            onDismiss={() => setSidebarOpen(false)}
          />
        ) : null}
        {!hideSidebar ? (
          <aside
            ref={sidebarRef}
            className={`fixed inset-y-0 left-0 z-40 flex shrink-0 bg-background after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-border pb-safe pt-safe transition-[translate] duration-200 ease-out motion-reduce:transition-none md:sticky md:top-0 md:h-[var(--rome-viewport-height)] md:translate-x-0 md:pb-0 md:pt-0 ${
              sidebarOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            {/* The edge line is drawn over the last pixel, not added as a
                border: a border would make the sidebar a pixel wider than the
                width the page is pushed by. */}
            {/* The rail never carries a border of its own: one would take a pixel
                from its width while the chat list shows, and shift every
                centered tile by half of it as the list opens and closes. */}
            {rail}
            {showChats ? (
              <div className="flex w-64 min-w-0 flex-col border-l border-border-subtle">
                {chatList}
              </div>
            ) : null}
            {/* The collapsed chat list, shown over the page rather than beside
                it, so a glance does not reflow the chat. */}
            {chatPeek.open ? (
              <div
                ref={peekRef}
                data-chat-peek
                className="absolute inset-y-0 flex w-64 min-w-0 flex-col border-x border-border bg-background shadow-10"
                style={{ left: `${railRem}rem` }}
              >
                {peekList}
              </div>
            ) : null}
          </aside>
        ) : null}
        {searchDialog}
        {/* The in-flow sidebar pushes routed content right by its own width on
            desktop — the rail, named or bare, plus the chat list when it shows — and with
            ?hideSidebar=1 there's no sidebar and content starts at the viewport
            edge. Publish that left offset so a `fixed` child like the trace
            drawer can align to the chat column. The public share tree has no
            shell, so its drawer falls back to 0px. */}
        <main
          ref={pageRef}
          className={`flex min-w-0 flex-1 flex-col bg-background max-md:transition-[translate] max-md:duration-200 max-md:ease-out motion-reduce:transition-none ${
            sidebarOpen && !hideSidebar
              ? railNames
                ? "max-md:translate-x-48"
                : "max-md:translate-x-16"
              : ""
          }`}
          style={
            {
              "--rome-chat-left": sidebarWidth,
            } as CSSProperties
          }
        >
          {!hideSidebar ? (
            <header
              data-mobile-header
              className="sticky top-0 z-10 flex h-[var(--rome-mobile-header-height)] shrink-0 items-center gap-2 border-b border-border bg-background px-2 pt-safe md:hidden"
            >
              <div className="flex shrink-0 items-center">
                {onChat ? (
                  // A chat is the detail of the chat list: this goes up to it.
                  <IconButton
                    size="md"
                    label={t("nav.chatList")}
                    icon={<ChevronLeft aria-hidden />}
                    onClick={() => setChatListOpen(true)}
                  />
                ) : null}
                <IconButton
                  size="md"
                  label={t("nav.openSidebar")}
                  icon={<HamburgerMenuIcon aria-hidden />}
                  onClick={() => setSidebarOpen(true)}
                />
              </div>
              {/* The chat page fills this with the session's identity + app
                  tabs + actions, mirroring the desktop chat navbar. Other routes
                  leave it empty, so the Rome wordmark fallback shows. */}
              <SlotOutlet
                name="mobileHeader"
                className="flex min-w-0 flex-1 items-center gap-2"
                fallback={
                  <Link to="/" className="flex items-center gap-2 min-h-[var(--control-min-h)]">
                    <img src="/icon.svg" alt="" aria-hidden className="h-5 w-5" />
                    <span className="text-ui text-foreground">{t("appName")}</span>
                  </Link>
                }
              />
            </header>
          ) : null}
          {routed}
          {phoneChatList ? (
            // Inside the page, so the drawer pushes it along like the page.
            <div
              data-phone-chat-list
              className="fixed inset-0 z-20 flex flex-col bg-background pb-safe pt-safe md:hidden"
            >
              <RecentChats
                headerLeading={
                  <IconButton
                    size="sm"
                    label={t("nav.openSidebar")}
                    icon={<HamburgerMenuIcon aria-hidden />}
                    onClick={() => setSidebarOpen(true)}
                    className="text-subtle-foreground hover:text-foreground"
                  />
                }
              />
            </div>
          ) : null}
        </main>
      </div>
    </div>
  );
}
