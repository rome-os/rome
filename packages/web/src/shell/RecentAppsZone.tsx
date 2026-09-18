import { ChevronDown, ChevronUp, Ellipsis, Pin } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RECENT_APPS_VISIBLE } from "@/lib/recent-apps";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ACTIVE_CLASS,
  IDLE_CLASS,
  LINK_CLASS,
  RAIL_LINK_CLASS,
  isEntryActive,
} from "./sidebar-shared";

interface RecentSidebarApp {
  id: string;
  displayName: string;
  iconUrl: string | null;
  href: string | null;
}

function SidebarAppIcon({ app }: { app: RecentSidebarApp }) {
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

interface RecentAppsZoneProps<T extends RecentSidebarApp> {
  /** Already filtered and ordered, most recent first. */
  apps: T[];
  unopenedIds: ReadonlySet<string>;
  pathname: string;
  onPin: (appId: string) => void;
  wrapWithContextMenu: (app: T, trigger: ReactNode) => ReactNode;
}

// The system-managed half of the sidebar: apps the guardian built or opened
// lately and has not pinned. It owns no data. An empty list renders nothing at
// all, divider included, so a sidebar with no recent apps is unchanged.
export function RecentAppsZone<T extends RecentSidebarApp>({
  apps,
  unopenedIds,
  pathname,
  onPin,
  wrapWithContextMenu,
}: RecentAppsZoneProps<T>) {
  const { t } = useTranslation("common");
  const { t: tApps } = useTranslation("apps");
  // Deliberately not persisted: a reload folds the zone back to its short form,
  // so the sidebar cannot grow long and stay long.
  const [expanded, setExpanded] = useState(false);

  if (apps.length === 0) return null;

  const visible = expanded ? apps : apps.slice(0, RECENT_APPS_VISIBLE);
  const hasMore = apps.length > RECENT_APPS_VISIBLE;

  return (
    <>
      <div className="mx-5 my-2 border-t border-border-subtle" />
      <nav aria-label={t("sidebar.recentApps")} className="flex flex-col gap-1 px-3">
        <div className="px-2 pb-1 pt-1 text-aux text-subtle-foreground">{t("sidebar.recent")}</div>
        {visible.map((app) => {
          if (!app.href) return null;
          const active = isEntryActive(pathname, app.href);
          const unopened = unopenedIds.has(app.id);
          return (
            <div key={app.id} className="group/recent relative">
              {wrapWithContextMenu(
                app,
                // Right padding reserves the pin button's slot. Touch devices
                // show that button permanently (`touch-show`), so there the
                // unopened dot needs a second slot beside it.
                <Link
                  to={app.href}
                  title={app.displayName}
                  className={cn(
                    LINK_CLASS,
                    "pr-8 [@media(hover:none)]:pr-16",
                    active ? ACTIVE_CLASS : IDLE_CLASS,
                  )}
                >
                  <SidebarAppIcon app={app} />
                  <span className="flex-1 truncate">{app.displayName}</span>
                </Link>,
              )}
              {unopened ? (
                <span
                  role="img"
                  aria-label={t("sidebar.notOpened")}
                  className="pointer-events-none absolute right-3 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-info transition-opacity group-hover/recent:opacity-0 group-focus-within/recent:opacity-0 [@media(hover:none)]:right-12"
                />
              ) : null}
              <button
                type="button"
                onClick={() => onPin(app.id)}
                aria-label={tApps("installed.pin")}
                title={tApps("installed.pin")}
                className="touch-show absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-4 text-subtle-foreground opacity-0 transition-opacity outline-none hover:text-foreground focus-visible:opacity-100 focus-visible:outline-solid focus-visible:outline-1 focus-visible:outline-ring/50 group-hover/recent:opacity-100"
              >
                <Pin className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
        {hasMore ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((prev) => !prev)}
            className={cn(
              LINK_CLASS,
              "text-subtle-foreground hover:bg-surface-hover hover:text-foreground",
            )}
          >
            {expanded ? (
              <ChevronUp className="h-4 w-4 shrink-0" aria-hidden />
            ) : (
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
            )}
            <span className="flex-1 truncate">
              {expanded ? t("sidebar.showLess") : t("sidebar.showMore")}
            </span>
          </button>
        ) : null}
      </nav>
    </>
  );
}

interface RecentAppsRailProps<T extends RecentSidebarApp> {
  apps: T[];
  unopenedIds: ReadonlySet<string>;
  pathname: string;
  wrapWithContextMenu: (app: T, trigger: ReactNode) => ReactNode;
}

// Rail form of the zone. A rail is the mode the guardian chose for being
// compact, so the overflow goes into a menu rather than a nested scroll area.
// Renders fragments into AppGrid's rail <nav>, inside its TooltipProvider.
export function RecentAppsRail<T extends RecentSidebarApp>({
  apps,
  unopenedIds,
  pathname,
  wrapWithContextMenu,
}: RecentAppsRailProps<T>) {
  const { t } = useTranslation("common");

  if (apps.length === 0) return null;

  const visible = apps.slice(0, RECENT_APPS_VISIBLE);
  const overflow = apps.slice(RECENT_APPS_VISIBLE);

  return (
    <>
      <Separator className="my-1 w-6" />
      {visible.map((app) => {
        if (!app.href) return null;
        const active = isEntryActive(pathname, app.href);
        return (
          <Tooltip key={app.id}>
            {wrapWithContextMenu(
              app,
              <TooltipTrigger asChild>
                <Link
                  to={app.href}
                  aria-label={app.displayName}
                  className={`${RAIL_LINK_CLASS} ${active ? ACTIVE_CLASS : IDLE_CLASS}`}
                >
                  <SidebarAppIcon app={app} />
                  {unopenedIds.has(app.id) ? (
                    <span
                      role="img"
                      aria-label={t("sidebar.notOpened")}
                      className="absolute right-2 top-2 h-2 w-2 rounded-full bg-info"
                    />
                  ) : null}
                </Link>
              </TooltipTrigger>,
            )}
            <TooltipContent side="right">{app.displayName}</TooltipContent>
          </Tooltip>
        );
      })}
      {overflow.length > 0 ? (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t("sidebar.moreRecentApps")}
                  className={`${RAIL_LINK_CLASS} ${IDLE_CLASS} text-subtle-foreground hover:text-foreground`}
                >
                  <Ellipsis className="h-4 w-4" aria-hidden />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">{t("sidebar.moreRecentApps")}</TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="right" align="start">
            {overflow.map((app) =>
              app.href ? (
                <DropdownMenuItem key={app.id} asChild>
                  <Link to={app.href}>
                    <SidebarAppIcon app={app} />
                    {app.displayName}
                  </Link>
                </DropdownMenuItem>
              ) : null,
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}
