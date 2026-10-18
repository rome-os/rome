import {
  ActivityLogIcon,
  ArchiveIcon,
  CalendarIcon,
  DashboardIcon,
  GearIcon,
  PersonIcon,
  Pencil2Icon,
} from "@radix-ui/react-icons";
import {
  AppWindow,
  ChartColumn,
  Chrome as ChromeIcon,
  Ellipsis,
  ExternalLink,
  FolderKanban,
  GripVertical,
  Info,
  MessageCircle,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Store,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { isElectronShell } from "@/lib/electron-shell";
import { saveSetting } from "@/lib/chat-api";
import { useAppCatalogChanges } from "@/hooks/use-app-catalog-events";
import { hasSession, useAuthStateSnapshot } from "@/lib/auth-state";
import { useApps, useInvalidateApps } from "@/hooks/use-apps";
import { useRecentApps } from "@/hooks/use-recent-apps";
import { useInvalidateSettings, useSettings } from "@/hooks/use-settings";
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from "@/components/ui/sortable";
import { chatSearchShortcutForPlatform } from "@/lib/chat-search-shortcut";
import { isCarrierApp } from "@/lib/chat-helpers";
import { RecentAppsRail, RecentAppsZone } from "./RecentAppsZone";
import { SidebarDisclosure, SidebarDivider } from "./SidebarDisclosure";
import {
  ACTIVE_CLASS,
  IDLE_CLASS,
  LINK_CLASS,
  RAIL_LINK_CLASS,
  isEntryActive,
} from "./sidebar-shared";

interface BuiltinNavEntry {
  id: string;
  href: string;
  labelKey: string;
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  sidebarIconMotion?: "apps" | "chat";
}

export const APP_NAV: readonly BuiltinNavEntry[] = [
  {
    id: "apps",
    href: "/apps",
    labelKey: "nav.apps",
    Icon: DashboardIcon,
    sidebarIconMotion: "apps",
  },
  { id: "projects", href: "/projects", labelKey: "nav.projects", Icon: FolderKanban },
  { id: "sessions", href: "/sessions", labelKey: "nav.sessions", Icon: ChartColumn },
  { id: "memory", href: "/memory", labelKey: "nav.memory", Icon: ArchiveIcon },
  { id: "people", href: "/people", labelKey: "nav.people", Icon: PersonIcon },
  { id: "routines", href: "/routines", labelKey: "nav.routines", Icon: CalendarIcon },
  { id: "activity", href: "/activity", labelKey: "nav.activity", Icon: ActivityLogIcon },
  { id: "store", href: "/apps/store", labelKey: "nav.store", Icon: Store },
  { id: "desktop", href: "/desktop", labelKey: "nav.desktop", Icon: ChromeIcon },
  {
    id: "chat",
    href: "/chat",
    labelKey: "nav.chat",
    Icon: Pencil2Icon,
    sidebarIconMotion: "chat",
  },
  { id: "settings", href: "/settings", labelKey: "nav.settings", Icon: GearIcon },
] as const;

// The sidebar's menu of Rome's own surfaces is fixed: these always lead it, in
// this order, and the guardian cannot reorder or remove them.
export const SIDEBAR_FIXED_IDS: readonly string[] = ["apps", "chat", "projects", "routines"];

// Built-ins behind the chevron on the divider below the fixed menu. They drop
// open beneath the divider, in this order.
export const SIDEBAR_MORE_IDS: readonly string[] = [
  "people",
  "sessions",
  "memory",
  "activity",
  "desktop",
];
const SIDEBAR_MORE_EXPANDED_KEY = "rome-sidebar-more-expanded";

// Pins hold the guardian's apps only. Earlier versions pinned built-in pages
// too, so stored lists can still carry `builtin` entries; parsing drops them.
export interface PinnedEntry {
  type: "app";
  id: string;
}

export const DEFAULT_SIDEBAR_PINS: PinnedEntry[] = [];

export const STORAGE_KEY = "rome-sidebar-pins";
const APPS_CACHE_KEY = "rome-sidebar-apps";

function pinKey(p: PinnedEntry): string {
  return `${p.type}:${p.id}`;
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
  return normalizeSidebarPins(raw);
}

export function normalizeSidebarPins(pins: readonly unknown[]): PinnedEntry[] {
  const seen = new Set<string>();
  const result: PinnedEntry[] = [];
  for (const item of pins) {
    if (typeof item !== "object" || item === null) continue;
    const { type, id } = item as { type?: unknown; id?: unknown };
    if (type !== "app" || typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    result.push({ type: "app", id });
  }
  return result;
}

function readMoreExpanded(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_MORE_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
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

function renderAppIcon(app: InstalledAppCard | CachedApp): React.ReactNode {
  if (app.iconUrl) {
    return (
      <img
        src={app.iconUrl}
        alt=""
        className="h-4 w-4 shrink-0 rounded-4"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-4 bg-surface-muted text-aux text-muted-foreground">
      {app.displayName.charAt(0).toUpperCase()}
    </span>
  );
}

function builtinEntries(ids: readonly string[]): BuiltinNavEntry[] {
  return ids.flatMap((id) => APP_NAV.find((entry) => entry.id === id) ?? []);
}

function isMorePageActive(pathname: string): boolean {
  return builtinEntries(SIDEBAR_MORE_IDS).some((b) => isEntryActive(pathname, b.href));
}

interface AppGridProps {
  /** Icon-rail rendering for the collapsed sidebar: entries become
   *  tooltip-labelled tiles and the edit affordances disappear. */
  collapsed?: boolean;
  /** Rail-only search tile. The expanded sidebar reaches search through
   *  RecentChats, which the rail has no room for. */
  onSearch?: () => void;
}

export function AppGrid({ collapsed, onSearch }: AppGridProps = {}) {
  const { t } = useTranslation("common");
  const { t: tApps } = useTranslation("apps");
  const location = useLocation();
  const navigate = useNavigate();
  const [pins, setPins] = useState<PinnedEntry[]>(() => readLocalPins() ?? DEFAULT_SIDEBAR_PINS);
  const [installedApps, setInstalledApps] =
    useState<(InstalledAppCard | CachedApp)[]>(readLocalApps);
  const [editing, setEditing] = useState(false);
  // A first load on one of the fold's pages starts open, so the fold never
  // paints shut and then jumps open.
  const [moreExpanded, setMoreExpanded] = useState(
    () => readMoreExpanded() || isMorePageActive(location.pathname),
  );
  const toggleMoreExpanded = useCallback(() => {
    const next = !moreExpanded;
    setMoreExpanded(next);
    try {
      localStorage.setItem(SIDEBAR_MORE_EXPANDED_KEY, next ? "1" : "0");
    } catch {}
  }, [moreExpanded]);
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
  const pinnedAppIds = useMemo(() => new Set(pins.map((pin) => pin.id)), [pins]);
  const { recent: recentApps, unopenedIds } = useRecentApps(installedApps, pinnedAppIds);

  useEffect(() => {
    if (!appsFromQuery) return;
    // Carriers (e.g. user-skills) never reach Recent, pins or the pin picker.
    const sidebarApps = appsFromQuery.filter((app) => !isCarrierApp(app.id));
    setInstalledApps(sidebarApps);
    writeLocalApps(sidebarApps);
  }, [appsFromQuery]);

  useEffect(() => {
    if (!settings) return;
    const serverPins = parsePins(settings.sidebarPins);
    if (serverPins) {
      setPins(serverPins);
      writeLocalPins(serverPins);
    }
  }, [settings]);

  useEffect(() => {
    const onExternalChange = () => {
      const local = readLocalPins();
      if (local) setPins(local);
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

  // The fixed menu has nothing to unpin, so its rows answer a right-click only
  // where there are tabs to open; without tabs, Open would repeat a click and
  // take over a long-press.
  const withBuiltinContextMenu = (
    entry: BuiltinNavEntry,
    trigger: React.ReactNode,
  ): React.ReactNode => {
    if (!canOpenNewTab) return trigger;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent>{renderOpenMenuItem(entry.href)}</ContextMenuContent>
      </ContextMenu>
    );
  };

  // onSelect runs after any item, for a caller that must close its own menu.
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
                persistPins(pins.filter((pin) => pin.id !== app.id));
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

  const fixedEntries = builtinEntries(SIDEBAR_FIXED_IDS);
  const moreEntries = builtinEntries(SIDEBAR_MORE_IDS);
  const activeMoreId = moreEntries.find((entry) =>
    isEntryActive(location.pathname, entry.href),
  )?.id;
  const moreActive = activeMoreId !== undefined;
  // Arriving on one of the group's pages opens the group, so the active row is
  // never hidden behind the fold. It reopens on each such arrival, including a
  // move between two of its pages, before the browser paints. A move within
  // one page leaves it as the guardian set it.
  useLayoutEffect(() => {
    if (activeMoreId) setMoreExpanded(true);
  }, [activeMoreId]);

  // Only pins whose app is installed with a frontend render; the rest wait in
  // storage in case the app comes back.
  const pinnedApps = pins.flatMap((pin) => {
    const app = installedApps.find((a) => a.id === pin.id);
    return app && app.hasFrontend && app.href ? [{ pin, app }] : [];
  });
  const unpinnedApps = installedApps.filter(
    (app) => app.hasFrontend && app.href && !pinnedAppIds.has(app.id),
  );

  const resolveLabel = (pin: PinnedEntry): string =>
    installedApps.find((a) => a.id === pin.id)?.displayName ?? pin.id;

  const resolveIcon = (pin: PinnedEntry): React.ReactNode => {
    const app = installedApps.find((a) => a.id === pin.id);
    return app ? renderAppIcon(app) : null;
  };

  if (collapsed) {
    const renderRailBuiltin = (entry: BuiltinNavEntry) => {
      const label = t(entry.labelKey);
      const active = isEntryActive(location.pathname, entry.href);
      return (
        <Tooltip key={`builtin-${entry.id}`}>
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
    };

    return (
      <TooltipProvider delayDuration={150}>
        <nav className="flex shrink-0 flex-col items-center gap-1 px-3 pb-2">
          {fixedEntries.map(renderRailBuiltin)}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("sidebar.more")}
                    className={`${RAIL_LINK_CLASS} ${moreActive ? ACTIVE_CLASS : IDLE_CLASS} text-subtle-foreground hover:text-foreground`}
                  >
                    <Ellipsis className="h-4 w-4" aria-hidden />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="right">{t("sidebar.more")}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="right" align="start">
              {moreEntries.map((entry) => {
                const active = isEntryActive(location.pathname, entry.href);
                return (
                  <DropdownMenuItem key={entry.id} asChild>
                    <Link
                      to={entry.href}
                      aria-current={active ? "page" : undefined}
                      className={active ? ACTIVE_CLASS : undefined}
                    >
                      <entry.Icon className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
                      {t(entry.labelKey)}
                    </Link>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          {pinnedApps.length > 0 ? <Separator className="my-1 w-6" /> : null}
          {pinnedApps.map(({ app }) => {
            const active = isEntryActive(location.pathname, app.href!);
            return (
              <Tooltip key={`app-${app.id}`}>
                {withAppContextMenu(
                  app,
                  <TooltipTrigger asChild>
                    <Link
                      to={app.href!}
                      aria-label={app.displayName}
                      className={`${RAIL_LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
                    >
                      {renderAppIcon(app)}
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
          })}
          <RecentAppsRail
            apps={recentApps}
            unopenedIds={unopenedIds}
            pathname={location.pathname}
            wrapWithContextMenu={(app, trigger, onSelect) =>
              withAppContextMenu(app, trigger, false, onSelect)
            }
          />
          {onSearch ? (
            <>
              <Separator className="my-1 w-6" />
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
                  {t("recentChats.searchShortcut", {
                    shortcut: chatSearchShortcutForPlatform(),
                  })}
                </TooltipContent>
              </Tooltip>
            </>
          ) : null}
        </nav>
      </TooltipProvider>
    );
  }

  const renderBuiltinRow = (entry: BuiltinNavEntry) => {
    const active = isEntryActive(location.pathname, entry.href);
    return (
      <Fragment key={`builtin-${entry.id}`}>
        {withBuiltinContextMenu(
          entry,
          <Link
            to={entry.href}
            title={t(entry.labelKey)}
            className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
          >
            {renderBuiltinIcon(entry)}
            <span className="flex-1 truncate">{t(entry.labelKey)}</span>
          </Link>,
        )}
      </Fragment>
    );
  };

  const pinnedControls = editing ? (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={() => setEditing(false)}
      className="text-subtle-foreground"
    >
      {t("sidebar.done")}
    </Button>
  ) : (
    <IconButton
      size="sm"
      label={t("sidebar.edit")}
      icon={<Pencil aria-hidden />}
      onClick={() => setEditing(true)}
      className="text-subtle-foreground hover:text-foreground"
    />
  );

  return (
    <div className="flex shrink-0 flex-col pb-2">
      <nav aria-label={t("sidebar.menu")} className="flex flex-col gap-1 px-3">
        {fixedEntries.map(renderBuiltinRow)}
      </nav>
      {moreExpanded ? (
        <nav
          id="sidebar-more"
          aria-label={t("sidebar.more")}
          className="mt-1 flex flex-col gap-1 px-3"
        >
          {moreEntries.map(renderBuiltinRow)}
        </nav>
      ) : null}
      <SidebarDisclosure
        expanded={moreExpanded}
        onToggle={toggleMoreExpanded}
        controls={moreExpanded ? "sidebar-more" : undefined}
        showLabel={t("sidebar.showMorePages")}
        hideLabel={t("sidebar.showFewerPages")}
      />

      <div className="flex items-center justify-between px-5 pb-1 pt-1">
        <span className="text-aux text-subtle-foreground">{t("sidebar.pinned")}</span>
        {pinnedControls}
      </div>

      {editing ? (
        <div className="flex flex-col gap-2 px-3">
          <Sortable value={pins} onValueChange={persistPins} getItemValue={pinKey}>
            <SortableContent className="flex flex-col gap-1">
              {pins.map((pin) => (
                <SortableItem
                  key={pinKey(pin)}
                  value={pinKey(pin)}
                  className="flex h-8 items-center gap-1 rounded-8 bg-surface px-1 py-1 text-ui text-foreground"
                >
                  <SortableItemHandle className="flex h-6 w-6 shrink-0 items-center justify-center rounded-4 text-subtle-foreground hover:text-foreground">
                    <GripVertical className="h-3.5 w-3.5" aria-hidden />
                  </SortableItemHandle>
                  {resolveIcon(pin)}
                  <span className="flex-1 truncate">{resolveLabel(pin)}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => persistPins(pins.filter((p) => pinKey(p) !== pinKey(pin)))}
                    aria-label={t("sidebar.remove")}
                    title={t("sidebar.remove")}
                    className="text-subtle-foreground hover:bg-transparent hover:text-destructive-fg dark:hover:bg-transparent"
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </SortableItem>
              ))}
            </SortableContent>
            <SortableOverlay>
              {({ value }) => {
                const pin = pins.find((p) => pinKey(p) === value);
                if (!pin) return null;
                return (
                  <div className="flex h-8 items-center gap-1 rounded-8 border border-border bg-background px-1 py-1 text-ui text-foreground shadow-10">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center text-subtle-foreground">
                      <GripVertical className="h-3.5 w-3.5" aria-hidden />
                    </span>
                    {resolveIcon(pin)}
                    <span className="flex-1 truncate">{resolveLabel(pin)}</span>
                    <span className="w-6" />
                  </div>
                );
              }}
            </SortableOverlay>
          </Sortable>

          {unpinnedApps.length > 0 ? (
            <>
              {pins.length > 0 ? <div className="border-t border-border-subtle" /> : null}
              <p className="text-aux text-subtle-foreground">{t("sidebar.addSection")}</p>
              <div className="flex flex-col gap-1">
                {unpinnedApps.map((app) => (
                  <div
                    key={app.id}
                    className="flex h-8 items-center gap-1 rounded-8 px-1 py-1 text-ui text-foreground hover:bg-surface-hover"
                  >
                    <span className="w-6" />
                    {renderAppIcon(app)}
                    <span className="flex-1 truncate">{app.displayName}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => persistPins([...pins, { type: "app", id: app.id }])}
                      aria-label={t("sidebar.add")}
                      title={t("sidebar.add")}
                      className="text-subtle-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <>
          {pinnedApps.length > 0 ? (
            <nav aria-label={t("sidebar.pinned")} className="flex flex-col gap-1 px-3">
              {pinnedApps.map(({ app }) => {
                const active = isEntryActive(location.pathname, app.href!);
                return (
                  <Fragment key={`app-${app.id}`}>
                    {withAppContextMenu(
                      app,
                      <Link
                        to={app.href!}
                        title={app.displayName}
                        className={`${LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
                      >
                        {renderAppIcon(app)}
                        <span className="flex-1 truncate">{app.displayName}</span>
                        {app.status === "disabled" ? (
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full bg-border-strong"
                            role="img"
                            aria-label={t("sidebar.appDisabled")}
                          />
                        ) : null}
                      </Link>,
                    )}
                  </Fragment>
                );
              })}
            </nav>
          ) : (
            <p className="px-5 pb-1 text-aux text-subtle-foreground">{t("sidebar.noPinned")}</p>
          )}
          <SidebarDivider />
          <RecentAppsZone
            apps={recentApps}
            unopenedIds={unopenedIds}
            pathname={location.pathname}
            onPin={(appId) => persistPins([...pins, { type: "app", id: appId }])}
            wrapWithContextMenu={(app, trigger) => withAppContextMenu(app, trigger, false)}
          />
        </>
      )}
    </div>
  );
}
