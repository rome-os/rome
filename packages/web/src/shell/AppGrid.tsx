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
  Chrome as ChromeIcon,
  Ellipsis,
  FolderKanban,
  GripVertical,
  MessagesSquare,
  PanelRightOpen,
  Pencil,
  PinOff,
  Plus,
  Search,
  Store,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { Fragment, useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { InstalledAppCard } from "@rome/api-types/apps";
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
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AppStoreSheet } from "@/components/AppStoreSheet";
import { APP_STORE_BROWSE_URL } from "@/lib/app-store-url";
import { isElectronShell } from "@/lib/electron-shell";
import { saveSetting } from "@/lib/chat-api";
import { useApps, useInvalidateApps } from "@/hooks/use-apps";
import { useNewApps } from "@/hooks/use-new-apps";
import { useInvalidateSettings, useSettings } from "@/hooks/use-settings";
import {
  Sortable,
  SortableContent,
  SortableItem,
  SortableItemHandle,
  SortableOverlay,
} from "@/components/ui/sortable";
import { chatSearchShortcutForPlatform } from "./ChatSearchDialog";

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
  { id: "sessions", href: "/sessions", labelKey: "nav.sessions", Icon: MessagesSquare },
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

export interface PinnedEntry {
  type: "builtin" | "app";
  id: string;
}

export const DEFAULT_SIDEBAR_PINS: PinnedEntry[] = [
  { type: "builtin", id: "apps" },
  { type: "builtin", id: "chat" },
  { type: "builtin", id: "projects" },
];

export const STORAGE_KEY = "rome-sidebar-pins";
const APPS_CACHE_KEY = "rome-sidebar-apps";
const REQUIRED_BUILTIN_PINS: PinnedEntry[] = [
  { type: "builtin", id: "apps" },
  { type: "builtin", id: "chat" },
];

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
    return Array.isArray(parsed) ? parsed : [];
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
    }));
    localStorage.setItem(APPS_CACHE_KEY, JSON.stringify(cached));
  } catch {}
}

function isEntryActive(pathname: string, href: string): boolean {
  if (href === "/apps" || href === "/chat") {
    return pathname === href;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

const LINK_CLASS =
  "rome-sidebar-link group flex h-8 w-full items-center gap-2 rounded-8 border border-transparent px-2 text-left text-ui text-foreground transition outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring";

// The rail counterpart of LINK_CLASS: a square tile whose tooltip carries the
// label. `relative` anchors the status dots that the wide rows render inline.
const RAIL_LINK_CLASS =
  "rome-sidebar-link relative flex size-10 items-center justify-center rounded-8 border border-transparent text-foreground transition outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring";

const RAIL_ACTIVE_CLASS = "bg-surface shadow-1 dark:bg-surface-hover";
const RAIL_IDLE_CLASS = "hover:bg-surface-hover dark:hover:bg-surface";

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
  headerControlsHost?: HTMLElement | null;
  /** Icon-rail rendering for the collapsed sidebar: pinned entries become
   *  tooltip-labelled tiles and the edit affordances disappear. */
  collapsed?: boolean;
  /** Rail-only search tile. The expanded sidebar reaches search through
   *  RecentChats, which the rail has no room for. */
  onSearch?: () => void;
}

export function AppGrid({ headerControlsHost, collapsed, onSearch }: AppGridProps = {}) {
  const { t } = useTranslation("common");
  const { t: tApps } = useTranslation("apps");
  const location = useLocation();
  const navigate = useNavigate();
  const [pins, setPins] = useState<PinnedEntry[]>(() =>
    normalizeSidebarPins(readLocalPins() ?? DEFAULT_SIDEBAR_PINS),
  );
  const [installedApps, setInstalledApps] =
    useState<(InstalledAppCard | CachedApp)[]>(readLocalApps);
  const [editing, setEditing] = useState(false);
  // Snapshot of the unacknowledged apps taken when the editor opens. Entering
  // edit mode also persists "seen" (clearing the dot), which would otherwise
  // empty `newAppIds` before the "Add section" renders — so the "New" badges
  // read from this frozen set, kept stable for the whole edit session.
  const [newlyShownIds, setNewlyShownIds] = useState<Set<string>>(new Set());
  const [storeOpen, setStoreOpen] = useState(false);
  const invalidateSettings = useInvalidateSettings();
  const invalidateApps = useInvalidateApps();

  const { data: settings } = useSettings();
  const { apps: appsFromQuery } = useApps();
  const { newAppIds, markAppsSeen } = useNewApps();

  useEffect(() => {
    if (!appsFromQuery) return;
    setInstalledApps(appsFromQuery);
    writeLocalApps(appsFromQuery);
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
    (appId: string) => {
      const currentChat = location.pathname === "/chat" || location.pathname.startsWith("/chat/");
      const destination = currentChat
        ? `${location.pathname}${location.search}${location.hash}`
        : "/chat";
      navigate(destination, {
        state: { widgets: [{ type: "app", appId }] },
      });
    },
    [location.hash, location.pathname, location.search, navigate],
  );

  const withAppContextMenu = (
    app: InstalledAppCard | CachedApp,
    trigger: React.ReactNode,
  ): React.ReactNode => {
    if (!app.href) return trigger;
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem asChild>
            <Link to={app.href}>
              <AppWindow aria-hidden />
              {tApps("installed.openButton")}
            </Link>
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => openAppInSplitView(app.id)}>
            <PanelRightOpen aria-hidden />
            {tApps("installed.openSplitTitle")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() =>
              persistPins(pins.filter((pin) => !(pin.type === "app" && pin.id === app.id)))
            }
          >
            <PinOff aria-hidden />
            {tApps("installed.unpin")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const builtinMap = new Map(APP_NAV.map((b) => [b.id, b]));

  const unpinnedApps = installedApps.filter(
    (app) => app.hasFrontend && app.href && !pins.some((p) => p.type === "app" && p.id === app.id),
  );
  const hiddenBuiltins = APP_NAV.filter(
    (b) =>
      !REQUIRED_BUILTIN_PINS.some((pin) => pin.id === b.id) &&
      !pins.some((p) => p.type === "builtin" && p.id === b.id),
  );
  const hasUnpinned = hiddenBuiltins.length > 0 || unpinnedApps.length > 0;

  // A "new" app only deserves a hint while it's actually hidden: once it's
  // pinned the user can see it, so an already-pinned app never lights the dot.
  // The dot rides the always-present "Apps" entry, whose page clears the ledger.
  const hasNewApps = [...newAppIds].some(
    (id) => !pins.some((p) => p.type === "app" && p.id === id),
  );

  const resolveLabel = (pin: PinnedEntry): string => {
    if (pin.type === "builtin") {
      const b = builtinMap.get(pin.id);
      return b ? t(b.labelKey) : pin.id;
    }
    const app = installedApps.find((a) => a.id === pin.id);
    return app?.displayName ?? pin.id;
  };

  const resolveIcon = (pin: PinnedEntry): React.ReactNode => {
    if (pin.type === "builtin") {
      const b = builtinMap.get(pin.id);
      if (!b) return null;
      return <b.Icon className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />;
    }
    const app = installedApps.find((a) => a.id === pin.id);
    if (!app) return null;
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
  };

  // The App Store lives on Rome Cloud. A browser opens it in a new tab, which
  // is what a tab is for. The Mac app has no tabs, and its shell hands every
  // new-window request to the system browser — so there the same anchor lands
  // the user in Safari, outside their Rome session. Only the desktop swaps to
  // the embedded sheet; the browser keeps the anchor.
  const inDesktopApp = isElectronShell();
  // Held here rather than at either call site: the rail and the wide sidebar
  // return separately, and both need it.
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

  if (collapsed) {
    return (
      <TooltipProvider delayDuration={150}>
        <nav className="flex shrink-0 flex-col items-center gap-1 px-3 pb-2">
          {pins.map((pin) => {
            if (pin.type === "builtin") {
              const entry = builtinMap.get(pin.id);
              if (!entry) return null;
              const label = t(entry.labelKey);
              if (entry.id === "store") {
                return (
                  <Tooltip key={`builtin-${pin.id}`}>
                    <TooltipTrigger asChild>
                      {inDesktopApp ? (
                        <button
                          type="button"
                          onClick={() => setStoreOpen(true)}
                          aria-label={label}
                          className={`${RAIL_LINK_CLASS} ${RAIL_IDLE_CLASS}`}
                        >
                          {renderBuiltinIcon(entry)}
                        </button>
                      ) : (
                        <a
                          href={APP_STORE_BROWSE_URL}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={label}
                          className={`${RAIL_LINK_CLASS} ${RAIL_IDLE_CLASS}`}
                        >
                          {renderBuiltinIcon(entry)}
                        </a>
                      )}
                    </TooltipTrigger>
                    <TooltipContent side="right">{label}</TooltipContent>
                  </Tooltip>
                );
              }
              const active = isEntryActive(location.pathname, entry.href);
              return (
                <Tooltip key={`builtin-${pin.id}`}>
                  <TooltipTrigger asChild>
                    <Link
                      to={entry.href}
                      aria-label={label}
                      className={`${RAIL_LINK_CLASS} ${active ? RAIL_ACTIVE_CLASS : RAIL_IDLE_CLASS}`}
                    >
                      {renderBuiltinIcon(entry)}
                      {/* The expanded sidebar hangs this dot on the edit menu,
                          which the rail hides — so here it rides the Apps tile,
                          whose page is still what clears the ledger. */}
                      {entry.id === "apps" && hasNewApps ? (
                        <span
                          className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-primary"
                          aria-label={t("sidebar.newApps")}
                        />
                      ) : null}
                    </Link>
                  </TooltipTrigger>
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
                      className={`${RAIL_LINK_CLASS} ${active ? RAIL_ACTIVE_CLASS : RAIL_IDLE_CLASS}`}
                    >
                      {resolveIcon(pin)}
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
          {onSearch ? (
            <>
              <Separator className="my-1 w-6" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onSearch}
                    aria-label={t("recentChats.search")}
                    className={`${RAIL_LINK_CLASS} ${RAIL_IDLE_CLASS} text-subtle-foreground hover:text-foreground`}
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
        {storeSheet}
      </TooltipProvider>
    );
  }

  const headerControls = editing ? (
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
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("sidebar.edit")}
          className="relative rounded-4 p-1 text-subtle-foreground transition hover:bg-surface-hover hover:text-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-foreground/30"
        >
          <Ellipsis className="h-4 w-4" aria-hidden />
          {hasNewApps ? (
            <span
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
              aria-label={t("sidebar.newApps")}
            />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="end">
        <DropdownMenuItem
          onSelect={() => {
            // Freeze which apps are "new" before persisting "seen", so the
            // badges survive the acknowledgement for this edit session.
            setNewlyShownIds(new Set(newAppIds));
            setEditing(true);
            // Opening the editor surfaces the new apps in "Add section",
            // so treat entering edit mode as the acknowledgement that
            // clears the dot.
            markAppsSeen();
          }}
        >
          <Pencil className="h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
          {t("sidebar.edit")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex shrink-0 flex-col pb-2">
      {headerControlsHost === undefined ? (
        <div className="flex items-center justify-end px-5 pb-2 pt-2">{headerControls}</div>
      ) : headerControlsHost ? (
        createPortal(headerControls, headerControlsHost)
      ) : null}

      {editing ? (
        <div className="flex flex-col gap-2 px-3">
          <Sortable value={pins} onValueChange={persistPins} getItemValue={pinKey}>
            <SortableContent className="flex flex-col gap-1">
              {pins.map((pin) => {
                const isRequiredBuiltin =
                  pin.type === "builtin" &&
                  REQUIRED_BUILTIN_PINS.some((requiredPin) => requiredPin.id === pin.id);
                return (
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
                    {!isRequiredBuiltin ? (
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
                    ) : (
                      <span className="w-6" />
                    )}
                  </SortableItem>
                );
              })}
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

          {hasUnpinned ? (
            <>
              <div className="border-t border-border-subtle" />
              <p className="text-aux text-subtle-foreground">{t("sidebar.addSection")}</p>
              <div className="flex flex-col gap-1">
                {hiddenBuiltins.map((b) => (
                  <div
                    key={b.id}
                    className="flex h-8 items-center gap-1 rounded-8 px-1 py-1 text-ui text-foreground hover:bg-surface-hover"
                  >
                    <span className="w-6" />
                    <b.Icon className="h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
                    <span className="flex-1 truncate">{t(b.labelKey)}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => persistPins([...pins, { type: "builtin", id: b.id }])}
                      aria-label={t("sidebar.add")}
                      title={t("sidebar.add")}
                      className="text-subtle-foreground hover:bg-transparent hover:text-foreground dark:hover:bg-transparent"
                    >
                      <Plus className="size-3.5" aria-hidden />
                    </Button>
                  </div>
                ))}
                {unpinnedApps.map((app) => (
                  <div
                    key={app.id}
                    className="flex h-8 items-center gap-1 rounded-8 px-1 py-1 text-ui text-foreground hover:bg-surface-hover"
                  >
                    <span className="w-6" />
                    {app.iconUrl ? (
                      <img src={app.iconUrl} alt="" className="h-4 w-4 shrink-0 rounded-4" />
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-4 bg-surface-muted text-aux text-muted-foreground">
                        {app.displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="flex-1 truncate">{app.displayName}</span>
                    {newlyShownIds.has(app.id) ? (
                      <span className="shrink-0 rounded-4 bg-primary/15 px-2 py-1 text-aux text-primary">
                        {t("sidebar.new")}
                      </span>
                    ) : null}
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
        <nav className="flex flex-col gap-1 px-3">
          {pins.map((pin) => {
            if (pin.type === "builtin") {
              const entry = builtinMap.get(pin.id);
              if (!entry) return null;
              if (entry.id === "store") {
                return inDesktopApp ? (
                  <button
                    key={`builtin-${pin.id}`}
                    type="button"
                    onClick={() => setStoreOpen(true)}
                    title={t(entry.labelKey)}
                    className={`${LINK_CLASS} hover:bg-surface-hover`}
                  >
                    {renderBuiltinIcon(entry)}
                    <span className="flex-1 truncate">{t(entry.labelKey)}</span>
                  </button>
                ) : (
                  <a
                    key={`builtin-${pin.id}`}
                    href={APP_STORE_BROWSE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={t(entry.labelKey)}
                    className={`${LINK_CLASS} hover:bg-surface-hover`}
                  >
                    {renderBuiltinIcon(entry)}
                    <span className="flex-1 truncate">{t(entry.labelKey)}</span>
                  </a>
                );
              }
              const active = isEntryActive(location.pathname, entry.href);
              return (
                <Link
                  key={`builtin-${pin.id}`}
                  to={entry.href}
                  title={t(entry.labelKey)}
                  className={`${LINK_CLASS} ${active ? "bg-surface shadow-1 dark:bg-surface-hover" : "hover:bg-surface-hover dark:hover:bg-surface"}`}
                >
                  {renderBuiltinIcon(entry)}
                  <span className="flex-1 truncate">{t(entry.labelKey)}</span>
                </Link>
              );
            }

            const app = installedApps.find((a) => a.id === pin.id);
            if (!app || !app.hasFrontend || !app.href) return null;
            const active = isEntryActive(location.pathname, app.href);
            return (
              <Fragment key={`app-${pin.id}`}>
                {withAppContextMenu(
                  app,
                  <Link
                    to={app.href}
                    title={app.displayName}
                    className={`${LINK_CLASS} ${active ? "bg-surface shadow-1 dark:bg-surface-hover" : "hover:bg-surface-hover dark:hover:bg-surface"}`}
                  >
                    {app.iconUrl ? (
                      <img
                        src={app.iconUrl}
                        alt=""
                        className="h-4 w-4 shrink-0 rounded-4"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : (
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-4 bg-surface-muted text-aux text-muted-foreground">
                        {app.displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
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
      )}
      {storeSheet}
    </div>
  );
}
