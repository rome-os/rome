import { AppWindow, ExternalLink, Info, MessageCircle, Pin, PinOff, Search } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { AppOrigin, InstalledAppCard } from "@rome/api-types/apps";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AppStoreSheet } from "@/components/AppStoreSheet";
import { APP_STORE_BROWSE_URL } from "@/lib/app-store-url";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { isElectronShell } from "@/lib/electron-shell";
import { saveSetting } from "@/lib/chat-api";
import { useAppCatalogChanges } from "@/hooks/use-app-catalog-events";
import { hasSession, useAuthStateSnapshot } from "@/lib/auth-state";
import { useApps, useInvalidateApps } from "@/hooks/use-apps";
import { useInvalidateSettings, useSettings } from "@/hooks/use-settings";
import { useRecentApps } from "@/hooks/use-recent-apps";
import { chatSearchShortcutForPlatform } from "@/lib/chat-search-shortcut";
import { isCarrierApp } from "@/lib/chat-helpers";
import { APP_NAV, type BuiltinNavEntry } from "./builtin-nav";
import { RailAppIcon, RecentAppsRail } from "./RecentAppsRail";
import { ACTIVE_CLASS, IDLE_CLASS, RAIL_LINK_CLASS, isEntryActive } from "./sidebar-shared";

export interface PinnedEntry {
  type: "builtin" | "app";
  id: string;
}

// The rail always leads with Rome's three main surfaces, in this order. They
// are not pins the guardian can remove; everything after them is.
const REQUIRED_BUILTIN_PINS: readonly PinnedEntry[] = [
  { type: "builtin", id: "apps" },
  { type: "builtin", id: "chat" },
  { type: "builtin", id: "projects" },
];

export const DEFAULT_SIDEBAR_PINS: PinnedEntry[] = [...REQUIRED_BUILTIN_PINS];

export const STORAGE_KEY = "rome-sidebar-pins";
const APPS_CACHE_KEY = "rome-sidebar-apps";

export function isRequiredBuiltinPin(id: string): boolean {
  return REQUIRED_BUILTIN_PINS.some((pin) => pin.id === id);
}

interface CachedApp {
  id: string;
  displayName: string;
  iconUrl: string | null;
  href: string | null;
  hasFrontend: boolean;
  status: string;
  origin?: AppOrigin;
  installedAt?: string | null;
  projectPath?: string | null;
}

function parsePins(raw: unknown): PinnedEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const valid = raw.filter(
    (item): item is PinnedEntry =>
      typeof item === "object" &&
      item !== null &&
      (item.type === "builtin" || item.type === "app") &&
      typeof item.id === "string",
  );
  if (valid.length === 0) return null;
  return valid;
}

export function normalizeSidebarPins(pins: PinnedEntry[]): PinnedEntry[] {
  const requiredIds = new Set(REQUIRED_BUILTIN_PINS.map((pin) => pin.id));
  const rest = pins.filter((pin) => !(pin.type === "builtin" && requiredIds.has(pin.id)));
  return [...REQUIRED_BUILTIN_PINS, ...rest];
}

function readLocalPins(): PinnedEntry[] | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    return parsePins(JSON.parse(stored));
  } catch {
    return null;
  }
}

function writeLocalPins(pins: PinnedEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pins));
  } catch {}
}

function readLocalApps(): CachedApp[] {
  try {
    const stored = localStorage.getItem(APPS_CACHE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.filter((app) => !isCarrierApp(app?.id)) : [];
  } catch {
    return [];
  }
}

function writeLocalApps(apps: InstalledAppCard[]): void {
  try {
    const cached: CachedApp[] = apps.map((a) => ({
      id: a.id,
      displayName: a.displayName,
      iconUrl: a.iconUrl,
      href: a.href,
      hasFrontend: a.hasFrontend,
      status: a.status,
      origin: a.origin,
      installedAt: a.installedAt ?? null,
      projectPath: a.projectPath,
    }));
    localStorage.setItem(APPS_CACHE_KEY, JSON.stringify(cached));
  } catch {}
}

function renderBuiltinIcon(entry: BuiltinNavEntry): React.ReactNode {
  return (
    <span
      className="rome-sidebar-icon flex h-4 w-4 shrink-0 items-center justify-center text-subtle-foreground"
      data-motion={entry.sidebarIconMotion}
      aria-hidden
    >
      <entry.Icon className="h-4 w-4 shrink-0" aria-hidden />
    </span>
  );
}

interface AppGridProps {
  /** Opens the search dialog. It finds pages, apps and chats, so it sits on
   *  the rail, which every page shows, and leads it as an action, not a page. */
  onSearch?: () => void;
  /** Pointer handlers that make the Chat tile open the collapsed chat list
   *  as a peek. The peek names the tile better than a tooltip would, so the
   *  tile shows none while these are set. */
  chatPeek?: { onPointerEnter: () => void; onPointerLeave: () => void };
}

// The sidebar's first column: search, Rome's main surfaces, the guardian's
// pins, then recent apps, as icon tiles whose tooltip carries the label.
export function AppGrid({ onSearch, chatPeek }: AppGridProps = {}) {
  const { t } = useTranslation("common");
  const { t: tApps } = useTranslation("apps");
  const location = useLocation();
  const navigate = useNavigate();
  const [pins, setPins] = useState<PinnedEntry[]>(() =>
    normalizeSidebarPins(readLocalPins() ?? DEFAULT_SIDEBAR_PINS),
  );
  const [installedApps, setInstalledApps] =
    useState<(InstalledAppCard | CachedApp)[]>(readLocalApps);
  const [storeOpen, setStoreOpen] = useState(false);
  const invalidateSettings = useInvalidateSettings();
  const invalidateApps = useInvalidateApps();
  // The Mac app has no tabs, and its shell hands every new-window request to
  // the system browser — which holds no Rome session, so the user lands in
  // Safari at a sign-in page. Anything here that would open a tab stays in the
  // window instead.
  const inDesktopApp = isElectronShell();
  // The mobile app's WebView has no tabs either. It answers a same-origin
  // `target="_blank"` by navigating itself to the target, so the app does open
  // — but after a full document load instead of a route change, and under a
  // label that promised a tab. That WebView sets no marker the dashboard could
  // read, which leaves the pointer as the nearest signal: a new tab is offered
  // only to a pointer that can right-click for one. Phone and tablet browsers
  // lose the item with it; asking the shell directly, as `isElectronShell`
  // does, needs the mobile app to identify itself first.
  const coarsePointer = useCoarsePointer();
  const canOpenNewTab = !inDesktopApp && !coarsePointer;
  // The list query only revalidates on mount and window focus, but the shell
  // stays mounted while the agent builds an app in the chat beside it. Listen
  // to the catalog stream so that app reaches the sidebar as it installs.
  const { bootstrap } = useAuthStateSnapshot();
  useAppCatalogChanges(hasSession(bootstrap), () => {
    void invalidateApps.list();
  });

  const { data: settings } = useSettings();
  const { apps: appsFromQuery } = useApps();
  const pinnedAppIds = useMemo(
    () => new Set(pins.filter((pin) => pin.type === "app").map((pin) => pin.id)),
    [pins],
  );
  const { recent: recentApps, unopenedIds } = useRecentApps(installedApps, pinnedAppIds);

  useEffect(() => {
    if (!appsFromQuery) return;
    // Carriers (e.g. user-skills) are plumbing, never a pin or a recent app.
    const sidebarApps = appsFromQuery.filter((app) => !isCarrierApp(app.id));
    setInstalledApps(sidebarApps);
    writeLocalApps(sidebarApps);
  }, [appsFromQuery]);

  useEffect(() => {
    if (!settings) return;
    const serverPins = parsePins(settings.sidebarPins);
    if (serverPins) {
      const resolved = normalizeSidebarPins(serverPins);
      setPins(resolved);
      writeLocalPins(resolved);
    }
  }, [settings]);

  useEffect(() => {
    const onExternalChange = () => {
      const local = readLocalPins();
      if (local) setPins(normalizeSidebarPins(local));
    };
    window.addEventListener("rome-pins-changed", onExternalChange);
    return () => window.removeEventListener("rome-pins-changed", onExternalChange);
  }, []);

  const persistPins = useCallback(
    (next: PinnedEntry[]) => {
      const safe = normalizeSidebarPins(next);
      setPins(safe);
      writeLocalPins(safe);
      void saveSetting("sidebarPins", safe).then(() => invalidateSettings());
      window.dispatchEvent(new Event("rome-pins-changed"));
    },
    [invalidateSettings],
  );

  const openAppInSplitView = useCallback(
    (app: InstalledAppCard | CachedApp) => {
      const currentChat = location.pathname === "/chat" || location.pathname.startsWith("/chat/");
      const destination = currentChat
        ? `${location.pathname}${location.search}${location.hash}`
        : "/chat";
      // Outside a chat, Chat with app starts a new one in the app's source
      // folder, as the app actions menu does. Inside a chat, the app joins the
      // conversation and the chat keeps its folder.
      const projectPath = location.pathname.startsWith("/chat/") ? null : app.projectPath;
      navigate(destination, {
        state: {
          widgets: [{ type: "app", appId: app.id }],
          ...(projectPath ? { projectPath } : {}),
        },
      });
    },
    [location.hash, location.pathname, location.search, navigate],
  );

  // A plain click on a sidebar row already opens it in place, so the menu's
  // open is the one a click cannot do: a new tab — wherever there are tabs.
  const renderOpenMenuItem = (href: string, onSelect?: () => void): React.ReactNode => (
    <ContextMenuItem asChild onSelect={onSelect}>
      {canOpenNewTab ? (
        <a href={href} target="_blank" rel="noopener noreferrer">
          <ExternalLink aria-hidden />
          {tApps("installed.openNewTabTitle")}
        </a>
      ) : (
        <Link to={href}>
          <AppWindow aria-hidden />
          {tApps("installed.openButton")}
        </Link>
      )}
    </ContextMenuItem>
  );

  // Rome's own surfaces sit in the same pin list as apps, so their rows answer
  // a right-click the same way. Split view is the one app action they lack:
  // the chat's side panel hosts app widgets only. The store row already leaves
  // the page, so it offers just Unpin, and the required pins offer no Unpin.
  const withBuiltinContextMenu = (
    entry: BuiltinNavEntry,
    trigger: React.ReactNode,
  ): React.ReactNode => {
    const canUnpin = !isRequiredBuiltinPin(entry.id);
    // Without tabs the open item is a plain Open, which a menu earns only
    // beside Unpin; alone it would repeat a click and take over a long-press.
    const canOpen = entry.id !== "store" && (canOpenNewTab || canUnpin);
    if (!canOpen && !canUnpin) return trigger;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent>
          {canOpen ? renderOpenMenuItem(entry.href) : null}
          {canOpen && canUnpin ? <ContextMenuSeparator /> : null}
          {canUnpin ? (
            <ContextMenuItem
              onSelect={() =>
                persistPins(pins.filter((pin) => !(pin.type === "builtin" && pin.id === entry.id)))
              }
            >
              <PinOff aria-hidden />
              {tApps("installed.unpin")}
            </ContextMenuItem>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  // A recent app offers Pin where a pinned one offers Unpin. onSelect runs
  // after any item, for a caller that must close its own menu.
  const withAppContextMenu = (
    app: InstalledAppCard | CachedApp,
    trigger: React.ReactNode,
    pinned = true,
    onSelect?: () => void,
  ): React.ReactNode => {
    if (!app.href) return trigger;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent>
          {renderOpenMenuItem(app.href, onSelect)}
          <ContextMenuItem
            onSelect={() => {
              openAppInSplitView(app);
              onSelect?.();
            }}
          >
            <MessageCircle aria-hidden />
            {tApps("installed.chatWithApp")}
          </ContextMenuItem>
          <ContextMenuItem asChild onSelect={onSelect}>
            <Link to={`/app-details/${encodeURIComponent(app.id)}`}>
              <Info aria-hidden />
              {tApps("installed.viewDetails")}
            </Link>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {pinned ? (
            <ContextMenuItem
              onSelect={() => {
                persistPins(pins.filter((pin) => !(pin.type === "app" && pin.id === app.id)));
                onSelect?.();
              }}
            >
              <PinOff aria-hidden />
              {tApps("installed.unpin")}
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              onSelect={() => {
                persistPins([...pins, { type: "app", id: app.id }]);
                onSelect?.();
              }}
            >
              <Pin aria-hidden />
              {tApps("installed.pin")}
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const builtinMap = new Map(APP_NAV.map((b) => [b.id, b]));

  // The App Store lives on Rome Cloud. A browser opens it in a new tab, which
  // is what a tab is for; the Mac app (see `inDesktopApp`) swaps to the embedded
  // sheet instead.
  const storeSheet = inDesktopApp ? (
    <AppStoreSheet
      open={storeOpen}
      onClose={() => setStoreOpen(false)}
      onInstalled={() => {
        void invalidateApps.list();
        void invalidateApps.updates();
      }}
    />
  ) : null;

  const renderPin = (pin: PinnedEntry): React.ReactNode => {
    if (pin.type === "builtin") {
      const entry = builtinMap.get(pin.id);
      if (!entry) return null;
      const label = t(entry.labelKey);
      if (entry.id === "store") {
        return (
          <Tooltip key={`builtin-${pin.id}`}>
            {withBuiltinContextMenu(
              entry,
              <TooltipTrigger asChild>
                {inDesktopApp ? (
                  <button
                    type="button"
                    onClick={() => setStoreOpen(true)}
                    aria-label={label}
                    className={`${RAIL_LINK_CLASS} ${IDLE_CLASS}`}
                  >
                    {renderBuiltinIcon(entry)}
                  </button>
                ) : (
                  <a
                    href={APP_STORE_BROWSE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={label}
                    className={`${RAIL_LINK_CLASS} ${IDLE_CLASS}`}
                  >
                    {renderBuiltinIcon(entry)}
                  </a>
                )}
              </TooltipTrigger>,
            )}
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        );
      }
      const active = isEntryActive(location.pathname, entry.href);
      if (entry.id === "chat" && chatPeek) {
        return (
          <Fragment key={`builtin-${pin.id}`}>
            {withBuiltinContextMenu(
              entry,
              <Link
                to={entry.href}
                aria-label={label}
                onPointerEnter={chatPeek.onPointerEnter}
                onPointerLeave={chatPeek.onPointerLeave}
                className={`${RAIL_LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
              >
                {renderBuiltinIcon(entry)}
              </Link>,
            )}
          </Fragment>
        );
      }
      return (
        <Tooltip key={`builtin-${pin.id}`}>
          {withBuiltinContextMenu(
            entry,
            <TooltipTrigger asChild>
              <Link
                to={entry.href}
                aria-label={label}
                className={`${RAIL_LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
              >
                {renderBuiltinIcon(entry)}
              </Link>
            </TooltipTrigger>,
          )}
          <TooltipContent side="right">{label}</TooltipContent>
        </Tooltip>
      );
    }

    const app = installedApps.find((a) => a.id === pin.id);
    if (!app || !app.hasFrontend || !app.href) return null;
    const active = isEntryActive(location.pathname, app.href);
    return (
      <Tooltip key={`app-${pin.id}`}>
        {withAppContextMenu(
          app,
          <TooltipTrigger asChild>
            <Link
              to={app.href}
              aria-label={app.displayName}
              className={`${RAIL_LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
            >
              <RailAppIcon app={app} />
              {app.status === "disabled" ? (
                <span
                  className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-border-strong"
                  role="img"
                  aria-label={t("sidebar.appDisabled")}
                />
              ) : null}
            </Link>
          </TooltipTrigger>,
        )}
        <TooltipContent side="right">{app.displayName}</TooltipContent>
      </Tooltip>
    );
  };

  const fixedCount = REQUIRED_BUILTIN_PINS.length;
  return (
    <TooltipProvider delayDuration={150}>
      <nav className="flex shrink-0 flex-col items-center gap-1 px-3 pb-2">
        {onSearch ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onSearch}
                aria-label={t("recentChats.search")}
                className={`${RAIL_LINK_CLASS} ${IDLE_CLASS} text-subtle-foreground hover:text-foreground`}
              >
                <Search className="h-4 w-4" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              {t("recentChats.searchShortcut", { shortcut: chatSearchShortcutForPlatform() })}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {pins.slice(0, fixedCount).map(renderPin)}
        {pins.length > fixedCount ? <Separator className="my-1 w-6" /> : null}
        {pins.slice(fixedCount).map(renderPin)}
        <RecentAppsRail
          apps={recentApps}
          unopenedIds={unopenedIds}
          pathname={location.pathname}
          wrapWithContextMenu={(app, trigger, onSelect) =>
            withAppContextMenu(app, trigger, false, onSelect)
          }
        />
      </nav>
      {storeSheet}
    </TooltipProvider>
  );
}
