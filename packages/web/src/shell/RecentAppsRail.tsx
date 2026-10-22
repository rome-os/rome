import { Ellipsis } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { RECENT_APPS_VISIBLE } from "@/lib/recent-apps";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ACTIVE_CLASS, IDLE_CLASS, RAIL_LINK_CLASS, isEntryActive } from "./sidebar-shared";

interface RecentSidebarApp {
  id: string;
  displayName: string;
  iconUrl: string | null;
  href: string | null;
}

export function RailAppIcon({ app }: { app: RecentSidebarApp }) {
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

interface RecentAppsRailProps<T extends RecentSidebarApp> {
  apps: T[];
  unopenedIds: ReadonlySet<string>;
  pathname: string;
  wrapWithContextMenu: (app: T, trigger: ReactNode, onSelect?: () => void) => ReactNode;
}

// Apps the guardian built or opened lately and has not pinned, below the pins.
// The rail has room for a few tiles only, so the rest go into a menu rather
// than a nested scroll area. An empty list renders nothing, divider included.
// Renders fragments into AppGrid's rail <nav>, inside its TooltipProvider.
export function RecentAppsRail<T extends RecentSidebarApp>({
  apps,
  unopenedIds,
  pathname,
  wrapWithContextMenu,
}: RecentAppsRailProps<T>) {
  const { t } = useTranslation("common");
  const [moreOpen, setMoreOpen] = useState(false);

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
                  <RailAppIcon app={app} />
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
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
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
            {/* Overflow rows answer a right-click like the tiles above them. The
                context menu sits on top of this one, so a choice there closes
                both. */}
            {overflow.map((app) =>
              app.href ? (
                <Fragment key={app.id}>
                  {wrapWithContextMenu(
                    app,
                    <DropdownMenuItem asChild>
                      <Link to={app.href}>
                        <RailAppIcon app={app} />
                        {app.displayName}
                      </Link>
                    </DropdownMenuItem>,
                    () => setMoreOpen(false),
                  )}
                </Fragment>
              ) : null,
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </>
  );
}
