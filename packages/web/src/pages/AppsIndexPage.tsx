import { Download, Ellipsis, Pin, Plus, Search, Store, X } from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import type { AppViewState, InstalledAppCard } from "@rome/api-types/apps";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { AppActionDropdownItems, getAppActionMenuEntries } from "@/components/app-action-menu";
import { AppRemixDialog } from "@/components/app-remix-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { AppStoreSheet } from "@/components/AppStoreSheet";
import { TileIcon } from "@/components/app-tile-icon";
import { getHostAppRoute } from "@/lib/auth-routing";
import { isImeCompositionEvent } from "@/lib/keyboard-submit";
import { cn } from "@/lib/utils";
import { ListLayout, ListToolbar } from "@rome-os/ui/layout-list";
import {
  PageActions,
  PageHeader,
  PageHeading,
  PageTitle,
  Section,
  SectionTitle,
} from "@rome-os/ui/page";
import { useAppsList, useInvalidateApps } from "@/hooks/use-apps";
import { useAppLifecycle } from "@/hooks/use-app-lifecycle";
import { useLongPressMenu } from "@/hooks/use-long-press-menu";
import { useNewApps } from "@/hooks/use-new-apps";
import { useSidebarPins } from "@/hooks/use-sidebar-pins";
import { APP_NAV } from "@/shell/AppGrid";

function isInFlight(phase: AppViewState): boolean {
  return phase === "installing" || phase === "uninstalling";
}

// Click handler that stops the click from reaching the tile's cover link.
function stopTileClick<T extends Element>(event: MouseEvent<T>): void {
  event.stopPropagation();
}

type ClickTarget = { type: "link"; href: string } | { type: "action"; onClick: () => void };

// One launcher tile: icon + name, with the app's actions menu reachable three
// ways — the hover/focus-revealed kebab, right-click anywhere on the tile, and
// long-press on touch. On coarse pointers the kebab is transparent and ignores
// taps (a grid of always-visible kebabs reads as clutter; long-press is the
// home-screen idiom) but stays in the tab order and a11y tree: long-press is
// pointer-only, and some menu items (Pin, View details on frontend apps) exist
// nowhere else on the tile, so keyboard and screen-reader users still need the
// trigger. The stretched cover link/button is what a plain click activates; the
// kebab sits above it on z-20.
interface AppTileProps {
  ariaLabel: string;
  clickTarget: ClickTarget;
  menuLabel: string;
  menu: ReactNode;
  menuDisabled?: boolean;
  icon: ReactNode;
  name: string;
  /** In-flight verb ("Uninstalling…") shown under the name while acting. */
  caption?: string | null;
}

function AppTile({
  ariaLabel,
  clickTarget,
  menuLabel,
  menu,
  menuDisabled,
  icon,
  name,
  caption,
}: AppTileProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Whether the one-line name label is actually clipped ("Competitor …").
  // Measured lazily right before the tooltip could open (cover pointerenter /
  // focus) rather than with a ResizeObserver: the answer only matters at that
  // moment, and hover-time measurement stays correct across grid reflows for
  // free.
  const [nameClipped, setNameClipped] = useState(false);
  const nameRef = useRef<HTMLSpanElement>(null);

  const longPress = useLongPressMenu({
    canOpen: !menuDisabled && !menuOpen,
    onOpen: () => setMenuOpen(true),
  });

  const coverClass =
    "absolute inset-0 z-10 rounded-12 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

  const syncNameClipped = () => {
    const el = nameRef.current;
    setNameClipped(el !== null && el.scrollWidth > el.clientWidth);
  };

  return (
    <div
      className="group relative flex select-none flex-col items-center rounded-12 p-3 transition-colors [-webkit-touch-callout:none] hover:bg-surface-muted has-[a:focus-visible]:bg-surface-muted has-[button:focus-visible]:bg-surface-muted"
      {...longPress.triggerProps}
    >
      {/* A clipped name reveals its full text in a tooltip on hover/focus.
          The cover is the trigger because it owns every pointer event over the
          tile (the name span sits beneath it), and its rect spans the tile, so
          side="bottom" lands the bubble right under the label. The content
          mounts only while the label is actually clipped — short names never
          grow a redundant bubble — and drops while the actions menu is open so
          the two popovers don't stack. Hoverable content is off: the bubble is
          pure text, and Radix's grace area would otherwise keep the previous
          tile's name floating while the pointer wanders the grid. */}
      <Tooltip disableHoverableContent>
        <TooltipTrigger asChild>
          {clickTarget.type === "link" ? (
            <Link
              to={clickTarget.href}
              aria-label={ariaLabel}
              className={coverClass}
              draggable={false}
              onClickCapture={longPress.suppressActivationClick}
              onPointerEnter={syncNameClipped}
              onFocus={syncNameClipped}
            />
          ) : (
            <button
              type="button"
              onClick={clickTarget.onClick}
              aria-label={ariaLabel}
              className={coverClass}
              onClickCapture={longPress.suppressActivationClick}
              onPointerEnter={syncNameClipped}
              onFocus={syncNameClipped}
            />
          )}
        </TooltipTrigger>
        {nameClipped && !menuOpen ? <TooltipContent side="bottom">{name}</TooltipContent> : null}
      </Tooltip>

      <div className="relative">{icon}</div>
      <span ref={nameRef} className="mt-2 w-full truncate text-center text-ui text-foreground">
        {name}
      </span>
      {caption ? (
        <span
          className="mt-1 w-full truncate text-center text-aux text-subtle-foreground"
          aria-live="polite"
        >
          {caption}
        </span>
      ) : null}

      {/* The wrapper must go tap-inert too: a bare div is hit-testable across
          its box even with nothing painted, and it sits above the z-10 cover
          link (a sibling, so a swallowed tap never reaches it). pointer-events
          rather than visibility so the trigger inside can still re-enable
          itself on focus/open. */}
      <div className="absolute -right-1 -top-1 z-20 pointer-coarse:pointer-events-none">
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton
              size="sm"
              label={menuLabel}
              icon={<Ellipsis aria-hidden />}
              disabled={menuDisabled}
              onClick={stopTileClick}
              className={cn(
                "h-7 w-7 rounded-8 bg-surface text-subtle-foreground shadow-1 ring-1 ring-border hover:text-foreground",
                // Hidden at rest, revealed on tile hover / keyboard focus /
                // while open.
                "opacity-0 transition-opacity focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
                // Coarse pointers: transparent and tap-inert, NOT visibility/
                // display-hidden — the button must stay focusable and in the
                // a11y tree (long-press is pointer-only and some menu items
                // have no other path from the tile), stray taps near the icon
                // must fall through to the tile, and the long-press menu
                // anchors to this button's rect, which display:none would
                // collapse. Tile keyboard focus restores tappability along
                // with visibility for touch devices with keyboards.
                "pointer-coarse:pointer-events-none pointer-coarse:group-focus-within:pointer-events-auto pointer-coarse:data-[state=open]:pointer-events-auto",
              )}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="bottom"
            align="end"
            className="w-56"
            onClick={stopTileClick}
            {...longPress.menuContentProps}
          >
            {menu}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

// Status badge on the icon's top-right corner: an available update (success)
// or a failed install (destructive). Decorative — the kebab's aria-label and
// the details page carry the accessible equivalents.
function TileStatusDot({ tone }: { tone: "update" | "error" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "absolute -right-1 -top-1 h-3 w-3 rounded-full ring-2 ring-background",
        tone === "update" ? "bg-success" : "bg-destructive",
      )}
    />
  );
}

// Dashed call-to-action tile closing the My apps / Installed apps grids: the
// section's "what goes here" affordance. It renders in both the empty and the
// populated state, so an empty section shows just the ghost instead of an
// explainer box.
interface GhostTileProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

function GhostTile({ icon, label, onClick }: GhostTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex select-none flex-col items-center rounded-12 p-3 transition-colors hover:bg-surface-muted outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
    >
      <span
        aria-hidden
        className="flex h-14 w-14 shrink-0 items-center justify-center rounded-16 border border-dashed border-border-strong text-primary sm:h-16 sm:w-16"
      >
        {icon}
      </span>
      <span className="mt-2 w-full truncate text-center text-ui font-medium text-primary">
        {label}
      </span>
    </button>
  );
}

// Header row for one provenance section (my / installed / built-in): title
// with a count pill. `count` is null while the apps list is loading so the
// pill doesn't flash a wrong number; a zero count drops the pill — the
// section's ghost tile already says the section is empty.
interface SectionHeaderProps {
  title: string;
  count: number | null;
}

function SectionHeader({ title, count }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-2">
      <SectionTitle>{title}</SectionTitle>
      {count !== null && count > 0 ? (
        <span className="rounded-full bg-primary/10 px-2 py-1 text-badge text-primary">
          {count}
        </span>
      ) : null}
    </div>
  );
}

export default function AppsIndexPage() {
  const { t } = useTranslation("apps");
  const { t: tCommon } = useTranslation("common");
  const navigate = useNavigate();
  const { apps, error: appsError } = useAppsList();
  const invalidateApps = useInvalidateApps();
  const lifecycle = useAppLifecycle(apps);
  const loadError = appsError ? appsError.message || t("installed.errors.loadFailed") : null;
  // Live filter across the apps grid (built-in surfaces + installed apps).
  // Matching is substring, case-insensitive, over each card's user-facing name,
  // its id, and (for built-ins) its description — the same things a user reads
  // on the card. Empty query means "show everything".
  const [query, setQuery] = useState("");
  const [storeOpen, setStoreOpen] = useState(false);
  const [remixTarget, setRemixTarget] = useState<InstalledAppCard | null>(null);
  const { isPinned, togglePin } = useSidebarPins();

  // Landing on the full apps list is the acknowledgement: clear the sidebar's
  // "new app" hint by marking every installed frontend app as seen.
  const { markAppsSeen } = useNewApps();
  useEffect(() => {
    markAppsSeen();
  }, [markAppsSeen]);

  const menusDisabled = lifecycle.lifecycleBusy || lifecycle.accessBusy;

  const openRemixDialog = (app: InstalledAppCard) => {
    setRemixTarget(app);
  };

  const closeRemixDialog = () => {
    setRemixTarget(null);
  };
  const builtinPages = APP_NAV.filter((b) => b.id !== "apps" && b.id !== "chat");

  const normalizedQuery = query.trim().toLowerCase();
  const isSearching = normalizedQuery.length > 0;
  const matchesBuiltin = (entry: (typeof APP_NAV)[number]): boolean => {
    if (!isSearching) return true;
    const haystack = [
      tCommon(entry.labelKey),
      t(`builtinDescriptions.${entry.id}`, { defaultValue: "" }),
      entry.id,
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  };
  const matchesApp = (app: InstalledAppCard): boolean => {
    if (!isSearching) return true;
    return `${app.displayName} ${app.id}`.toLowerCase().includes(normalizedQuery);
  };
  const visibleBuiltins = builtinPages.filter(matchesBuiltin);
  // `null` while the installed list is still loading — kept distinct from the
  // empty array so the skeleton (loading) and the empty state (no matches) don't
  // collide. Filtering applies live once the list lands.
  const visibleApps = apps === null ? null : apps.filter(matchesApp);
  // The grid is sectioned by the server-derived provenance (`AppOrigin`):
  // apps built on this instance, App Store installs, and the built-in group,
  // which pairs first-party apps with Rome's own surfaces (APP_NAV).
  const visibleMyApps = visibleApps?.filter((app) => app.origin === "local") ?? [];
  const visibleStoreApps = visibleApps?.filter((app) => app.origin === "appstore") ?? [];
  const visibleBuiltinApps = visibleApps?.filter((app) => app.origin === "builtin") ?? [];
  const resultCount = visibleBuiltins.length + (visibleApps?.length ?? 0);
  // Only an empty *after the list has loaded* counts as "no matches"; a pending
  // load keeps showing skeletons even when a query is active.
  const noMatches = isSearching && visibleApps !== null && resultCount === 0;

  const renderBuiltinTile = (entry: (typeof APP_NAV)[number]) => {
    const label = tCommon(entry.labelKey);
    const pinned = isPinned("builtin", entry.id);
    return (
      <AppTile
        key={`builtin:${entry.id}`}
        ariaLabel={label}
        clickTarget={
          entry.id === "store"
            ? { type: "action", onClick: () => setStoreOpen(true) }
            : { type: "link", href: entry.href }
        }
        menuLabel={t("installed.moreActionsAria", { name: label })}
        menu={
          <DropdownMenuItem
            onClick={() => togglePin("builtin", entry.id)}
            className="text-foreground"
          >
            <Pin className="h-3.5 w-3.5 text-subtle-foreground" aria-hidden />
            {pinned ? t("installed.unpin") : t("installed.pin")}
          </DropdownMenuItem>
        }
        icon={<TileIcon size="lg" kind="builtin" displayName={label} BuiltinIcon={entry.Icon} />}
        name={label}
      />
    );
  };

  const renderInstalledMenuItems = (app: InstalledAppCard) => (
    <AppActionDropdownItems
      entries={getAppActionMenuEntries({
        app,
        lifecycle,
        t,
        disabled: menusDisabled,
        pin: { pinned: isPinned("app", app.id), onToggle: () => togglePin("app", app.id) },
        onRemix: () => openRemixDialog(app),
      })}
    />
  );

  const renderInstalledTile = (app: InstalledAppCard) => {
    // An app is openable either via its own embedded frontend (`href`) or via a
    // host route registered for a backend-only app (see HOST_APP_ROUTES in
    // lib/auth-routing.ts — shared with App.tsx routing and auth classification).
    // Everything else opens its details page — every tile goes somewhere.
    const embeddedHref = app.hasFrontend && app.href ? app.href : null;
    const hostRoute = getHostAppRoute(app.id);
    const targetHref = embeddedHref ?? hostRoute;
    const candidate = lifecycle.freshCandidate(app);
    const busyLabel =
      lifecycle.actingLabelFor(app) ?? (isInFlight(app.phase) ? t(`phase.${app.phase}`) : null);
    const hasError = Boolean(app.error) || app.status === "failed";

    return (
      <AppTile
        key={`installed:${app.id}`}
        ariaLabel={
          targetHref
            ? t("installed.openLabelAria", { name: app.displayName })
            : t("installed.openDetailsAria", { name: app.displayName })
        }
        clickTarget={{
          type: "link",
          href: targetHref ?? `/app-details/${encodeURIComponent(app.id)}`,
        }}
        menuLabel={
          candidate
            ? t("installed.moreActionsWithUpdateAria", {
                name: app.displayName,
                version: candidate.availableVersion,
              })
            : t("installed.moreActionsAria", { name: app.displayName })
        }
        menu={renderInstalledMenuItems(app)}
        menuDisabled={menusDisabled}
        icon={
          <>
            <TileIcon
              size="lg"
              kind="image"
              displayName={app.displayName}
              iconUrl={app.iconUrl}
              muted={app.status === "disabled"}
            />
            {busyLabel ? (
              <span className="absolute inset-0 flex items-center justify-center rounded-16 bg-surface/70">
                <Spinner label={busyLabel} className="text-foreground" />
              </span>
            ) : hasError ? (
              <TileStatusDot tone="error" />
            ) : candidate ? (
              <TileStatusDot tone="update" />
            ) : null}
          </>
        }
        name={app.displayName}
        caption={busyLabel}
      />
    );
  };

  // While a search is active, a section with no matches disappears entirely;
  // during load every section stays mounted so the skeletons have a home.
  const showMySection = apps === null || !isSearching || visibleMyApps.length > 0;
  const showStoreSection = apps === null || !isSearching || visibleStoreApps.length > 0;
  const showBuiltinSection =
    apps === null || !isSearching || visibleBuiltins.length + visibleBuiltinApps.length > 0;

  // The "New app" ghost tile hands off to the chat composer with a seeded
  // draft — app creation is an agent task (app_management create), not a
  // dashboard form.
  const startNewAppDraft = () =>
    navigate("/chat", { state: { draft: t("sections.my.newAppDraft") } });

  const tileGridClass =
    "grid grid-cols-[repeat(auto-fill,minmax(6rem,1fr))] gap-x-2 gap-y-4 sm:grid-cols-[repeat(auto-fill,minmax(7rem,1fr))]";

  const renderSkeletonTiles = (prefix: string, count: number) =>
    Array.from({ length: count }).map((_, index) => (
      <div
        key={`skeleton:${prefix}:${index}`}
        className="flex flex-col items-center gap-2 p-3"
        aria-hidden
      >
        <Skeleton className="h-14 w-14 rounded-16 sm:h-16 sm:w-16" />
        <Skeleton className="h-3 w-16 sm:h-3.5 sm:w-18" />
      </div>
    ));

  const myAppsCount =
    apps === null
      ? null
      : isSearching
        ? visibleMyApps.length
        : apps.filter((app) => app.origin === "local").length;
  const storeAppsCount =
    apps === null
      ? null
      : isSearching
        ? visibleStoreApps.length
        : apps.filter((app) => app.origin === "appstore").length;
  // Built-in = Rome's own surfaces plus the first-party apps shipped with it.
  const builtinCount =
    apps === null
      ? null
      : isSearching
        ? visibleBuiltins.length + visibleBuiltinApps.length
        : builtinPages.length + apps.filter((app) => app.origin === "builtin").length;
  const updatesCount = lifecycle.upgradeTargets.length;

  return (
    // One tooltip provider for the whole grid: the delay keeps a sweep across
    // the tiles quiet, while Radix's shared skip-delay makes the next tile's
    // name appear instantly once one tooltip is already showing.
    <TooltipProvider delayDuration={300}>
      {/* The launcher is a List: the guardian scans or searches it for one app
          and opens it. The header carries what the page is, and the toolbar
          carries what narrows the collection, which is the split in
          docs/ui/layouts.md. The actions here are two buttons that may wrap, so
          the header keeps the default `start` alignment rather than the `end`
          a lone view switch takes. */}
      <ListLayout>
        <PageHeader>
          <PageHeading>
            <PageTitle>{t("header.title")}</PageTitle>
          </PageHeading>
          <PageActions>
            <Button
              type="button"
              size="sm"
              onClick={lifecycle.upgradeAll}
              disabled={updatesCount === 0 || menusDisabled}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {lifecycle.bulkUpgradePending
                ? t("installed.updateAllUpdating")
                : t("installed.updateAll")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setStoreOpen(true)}>
              {t("header.appStore")}
            </Button>
          </PageActions>
        </PageHeader>

        {/* Search is the only control that narrows the launcher, so it leads the
            row alone — one filter does not earn the Filter control the toolbar
            rule collapses three into. The field keeps its own tab stop, which
            is what typing into a toolbar needs. */}
        <ListToolbar aria-label={t("search.toolbarLabel")}>
          <div className="relative w-full sm:max-w-sm">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground"
              aria-hidden
            />
            <Input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                // Escape clears, but not mid-IME-composition: CJK users press
                // Escape to cancel the candidate buffer, and clearing the whole
                // query then would be destructive. Same guard the chat composer
                // uses for Enter.
                if (event.key === "Escape" && !isImeCompositionEvent(event)) setQuery("");
              }}
              placeholder={t("search.placeholder")}
              aria-label={t("search.ariaLabel")}
              className="h-9 pl-8 pr-8"
            />
            {query ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={() => setQuery("")}
                aria-label={t("search.clear")}
                title={t("search.clear")}
                // Centered with `inset-y-0 my-auto`, not `-translate-y-1/2`:
                // Button's base carries an active-press `translate-y-px` on a
                // different variant prefix, so a centering transform survives
                // the merge and the glyph drops half its height while pressed.
                // Auto margins split the 36px field's spare 12px evenly around
                // the 24px button without naming an off-scale 6px offset.
                className="absolute inset-y-0 right-2 my-auto text-subtle-foreground hover:bg-surface-muted hover:text-foreground dark:hover:bg-surface-muted"
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            ) : null}
          </div>
          {isSearching ? (
            <p className="text-aux text-muted-foreground" aria-live="polite">
              {t("search.resultsCount", { count: resultCount })}
            </p>
          ) : null}
        </ListToolbar>

        {loadError ? (
          <p className="rounded-8 bg-destructive-bg px-4 py-3 text-ui text-destructive-fg">
            {loadError}
          </p>
        ) : null}

        {noMatches ? (
          <EmptyState className="rounded-12 border border-dashed border-border bg-surface/50">
            <EmptyStateIcon>
              <Search className="h-5 w-5" aria-hidden />
            </EmptyStateIcon>
            <EmptyStateTitle>{t("search.noResults", { query: query.trim() })}</EmptyStateTitle>
            <EmptyStateDescription>{t("search.noResultsHint")}</EmptyStateDescription>
            <EmptyStateAction>
              <Button type="button" variant="outline" size="sm" onClick={() => setQuery("")}>
                {t("search.clear")}
              </Button>
            </EmptyStateAction>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-6" aria-busy={apps === null}>
            {showMySection ? (
              <Section aria-label={t("sections.my.title")}>
                <SectionHeader title={t("sections.my.title")} count={myAppsCount} />
                {apps === null ? (
                  <div className={tileGridClass}>{renderSkeletonTiles("my", 4)}</div>
                ) : (
                  <div className={tileGridClass}>
                    {visibleMyApps.map((app) => renderInstalledTile(app))}
                    {/* Hidden while searching so the grid holds only matches. */}
                    {isSearching ? null : (
                      <GhostTile
                        icon={<Plus className="h-6 w-6 sm:h-7 sm:w-7" />}
                        label={t("sections.my.newApp")}
                        onClick={startNewAppDraft}
                      />
                    )}
                  </div>
                )}
              </Section>
            ) : null}

            {showStoreSection ? (
              <Section aria-label={t("sections.appstore.title")}>
                <SectionHeader title={t("sections.appstore.title")} count={storeAppsCount} />
                {apps === null ? (
                  <div className={tileGridClass}>{renderSkeletonTiles("appstore", 4)}</div>
                ) : (
                  <div className={tileGridClass}>
                    {visibleStoreApps.map((app) => renderInstalledTile(app))}
                    {isSearching ? null : (
                      <GhostTile
                        icon={<Store className="h-6 w-6 sm:h-7 sm:w-7" />}
                        label={t("sections.appstore.browseStore")}
                        onClick={() => setStoreOpen(true)}
                      />
                    )}
                  </div>
                )}
              </Section>
            ) : null}

            {showBuiltinSection ? (
              <Section aria-label={t("sections.builtin.title")}>
                <SectionHeader title={t("sections.builtin.title")} count={builtinCount} />
                <div className={tileGridClass}>
                  {visibleBuiltins.map((entry) => renderBuiltinTile(entry))}
                  {visibleBuiltinApps.map((app) => renderInstalledTile(app))}
                </div>
              </Section>
            ) : null}
          </div>
        )}

        {lifecycle.dialogs}

        <AppRemixDialog app={remixTarget} onClose={closeRemixDialog} />

        <AppStoreSheet
          open={storeOpen}
          onClose={() => setStoreOpen(false)}
          onInstalled={() => {
            void invalidateApps.list();
            void invalidateApps.updates();
          }}
        />
      </ListLayout>
    </TooltipProvider>
  );
}
