import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { InstalledAppCard } from "@rome/api-types/apps";
import {
  AppActionSheet,
  AppActionDropdownItems,
  getAppActionMenuEntries,
} from "@/components/app-action-menu";
import { AppRemixDialog } from "@/components/app-remix-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppsList } from "@/hooks/use-apps";
import { useAppLifecycle } from "@/hooks/use-app-lifecycle";
import { useCoarsePointer } from "@/hooks/use-coarse-pointer";
import { useSidebarPins } from "@/hooks/use-sidebar-pins";
import { cn } from "@/lib/utils";

/**
 * Floating app-actions trigger for the embedded app view (`/apps/:appId`) —
 * the same menu the launcher grid offers on right-click, reachable without
 * leaving the app. The Rome mark signals the widget is host chrome, not part
 * of the app; it sits translucent at rest because it overlays content the app
 * owns, and solidifies on hover/focus/open. Guardian-only (the caller gates on
 * the manifest's caller kind) and absent from `/full/apps/:appId`, which is
 * the user-facing surface.
 *
 * Fine pointers get an anchored dropdown; coarse pointers get the bottom
 * action sheet, whose identity header restates the target app.
 */
export function AppActionsFab({ appId }: { appId: string }) {
  const { t } = useTranslation("apps");
  const navigate = useNavigate();
  const coarse = useCoarsePointer();
  const { apps } = useAppsList();
  const { isPinned, togglePin } = useSidebarPins();
  // probeUpdates: false — the details-page contract: a deep link into an app
  // must not fan out the expensive per-app updates probe. The upgrade entry
  // still appears when a visit to the grid already left a candidate in cache.
  const lifecycle = useAppLifecycle(apps, {
    probeUpdates: false,
    onUninstalled: () => navigate("/apps"),
  });
  const [sheetOpen, setSheetOpen] = useState(false);
  const [remixTarget, setRemixTarget] = useState<InstalledAppCard | null>(null);

  const app = apps?.find((candidate) => candidate.id === appId) ?? null;
  if (!app) return null;

  const entries = getAppActionMenuEntries({
    app,
    lifecycle,
    t,
    disabled: lifecycle.lifecycleBusy || lifecycle.accessBusy,
    pin: { pinned: isPinned("app", app.id), onToggle: () => togglePin("app", app.id) },
    onRemix: () => setRemixTarget(app),
  });

  const triggerLabel = t("installed.moreActionsAria", { name: app.displayName });
  // z-40 matches the sidebar layer: above the app's content, below the z-50
  // dialogs/sheets this very menu opens. Safe-area-aware bottom offset so the
  // button clears the home indicator on mobile.
  const triggerClass = cn(
    "fixed bottom-[max(var(--rome-safe-area-bottom),1rem)] right-4 z-40 flex h-10 w-10 items-center justify-center rounded-full bg-surface shadow-4 ring-1 ring-border",
    "opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
    "outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50",
    "pointer-coarse:h-12 pointer-coarse:w-12",
  );
  const triggerIcon = <img src="/icon.svg" alt="" aria-hidden className="h-5 w-5" />;

  return (
    <>
      {coarse ? (
        <>
          <button
            type="button"
            aria-label={triggerLabel}
            title={triggerLabel}
            onClick={() => setSheetOpen(true)}
            className={cn(triggerClass, sheetOpen && "opacity-100")}
          >
            {triggerIcon}
          </button>
          <AppActionSheet
            open={sheetOpen}
            app={app}
            entries={entries}
            closeLabel={t("installed.closeActionsAria")}
            onClose={() => setSheetOpen(false)}
          />
        </>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={triggerLabel}
              title={triggerLabel}
              className={triggerClass}
            >
              {triggerIcon}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-56">
            <AppActionDropdownItems entries={entries} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {lifecycle.dialogs}
      <AppRemixDialog app={remixTarget} onClose={() => setRemixTarget(null)} />
    </>
  );
}
