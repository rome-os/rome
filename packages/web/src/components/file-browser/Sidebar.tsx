import type { CSSProperties, MouseEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus, FolderPlus, Plus, Search } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";
import { Tree } from "./Tree";
import { useSidebarResize } from "./hooks/useSidebarResize";
import { usePersistedSidebarWidth } from "./hooks/usePersistedSidebarWidth";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  getIsDesktopViewport,
} from "./store/utils";
import { SidebarRootContextMenu, type ContextMenuActions } from "./ContextMenu";

interface SidebarProps {
  rootLabel: string;
  rootPanelTrigger: boolean;
  sidebarHeading?: string;
  searchPlaceholder: string;
  contextMenuActions: ContextMenuActions;
}

export function Sidebar({
  rootLabel,
  rootPanelTrigger,
  sidebarHeading,
  searchPlaceholder,
  contextMenuActions,
}: SidebarProps) {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const logicalRootPath = useFileBrowserStore((s) => s.config.logicalRootPath);
  const sidebarWidth = useFileBrowserStore((s) => s.ui.sidebarWidth);
  const isResizingSidebar = useFileBrowserStore((s) => s.ui.isResizingSidebar);
  const tree = useFileBrowserStore((s) => s.tree.nodes);
  const creating = useFileBrowserStore((s) => s.ui.creating);
  const deleting = useFileBrowserStore((s) => s.ui.deleting);
  const moving = useFileBrowserStore((s) => s.ui.moving);
  const renaming = useFileBrowserStore((s) => s.ui.renaming);
  const uploading = useFileBrowserStore((s) => s.ui.uploading);
  const searchQuery = useFileBrowserStore((s) => s.ui.searchQuery);
  const searching = useFileBrowserStore((s) => s.ui.searching);

  const sidebarStorageKey = usePersistedSidebarWidth(logicalRootPath);
  useSidebarResize(sidebarStorageKey);

  const handleSidebarEmptyClick = (event: MouseEvent<HTMLElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      !target ||
      target.closest(
        "a, button, input, select, textarea, [role='button'], [role='menuitem'], [role='separator']",
      )
    ) {
      return;
    }
    store.getState().selection.clearMultiSelect();
  };

  const handleSidebarResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    store.getState().refs.sidebarResize = {
      startWidth: sidebarWidth,
      startX: event.clientX,
    };
    store.getState().ui.setIsResizingSidebar(true);
  };

  const resetSidebarWidth = () => {
    store.getState().ui.setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    try {
      window.localStorage.removeItem(sidebarStorageKey);
    } catch {
      // Width persistence is a convenience only.
    }
  };

  return (
    <aside
      className="relative w-[var(--file-browser-sidebar-width)] flex-shrink-0 border-r border-border bg-surface"
      style={{ "--file-browser-sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      onClick={handleSidebarEmptyClick}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
          {rootPanelTrigger ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                void store.getState().selection.guardedSelectFolder(logicalRootPath, {
                  syncUrl: getIsDesktopViewport(),
                });
              }}
              // `shrink` defeats the primitive's base `shrink-0` so a long
              // heading yields to the "+" trigger beside it, and the ellipsis
              // lives on an inner span: `text-overflow` has no effect on the
              // flex container itself.
              className="min-w-0 shrink justify-start text-left"
            >
              <span className="min-w-0 truncate">{sidebarHeading ?? t("sidebar.heading")}</span>
            </Button>
          ) : (
            <h2 className="truncate text-section text-foreground">
              {sidebarHeading ?? t("sidebar.heading")}
            </h2>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                size="sm"
                disabled={creating}
                label={t("sidebar.new")}
                icon={<Plus strokeWidth={1.8} aria-hidden="true" />}
                className="text-muted-foreground hover:bg-surface-muted hover:text-foreground"
              />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="min-w-[10rem]">
              <DropdownMenuItem onSelect={() => store.getState().ui.createPath("file")}>
                <FilePlus size={14} strokeWidth={1.6} aria-hidden="true" />
                <span>{t("sidebar.newFile")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => store.getState().ui.createPath("folder")}>
                <FolderPlus size={14} strokeWidth={1.6} aria-hidden="true" />
                <span>{t("sidebar.newFolder")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="border-b border-border-subtle px-3 py-2">
          <div className="relative flex items-center">
            <Search
              size={14}
              strokeWidth={1.8}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 text-subtle-foreground"
            />
            <Input
              type="text"
              size="sm"
              placeholder={searchPlaceholder}
              value={searchQuery}
              onChange={(event) => store.getState().ui.setSearchQuery(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && void store.getState().ui.doSearch()}
              className="flex-1 pl-8"
              aria-label={t("header.search")}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void store.getState().ui.doSearch()}
              disabled={searching || !searchQuery.trim()}
              className="ml-2"
            >
              {searching ? t("header.searchPending") : t("header.search")}
            </Button>
          </div>
        </div>
        {(uploading || creating || deleting || moving || renaming) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-1 text-aux">
            {uploading && <span className="text-muted-foreground">{t("status.uploading")}</span>}
            {creating && <span className="text-muted-foreground">{t("status.creating")}</span>}
            {deleting && <span className="text-muted-foreground">{t("status.deleting")}</span>}
            {moving && <span className="text-muted-foreground">{t("status.moving")}</span>}
            {renaming && <span className="text-muted-foreground">{t("status.renaming")}</span>}
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
          <div className="flex min-h-full flex-col p-3">
            {tree.length > 0 && <Tree contextMenuActions={contextMenuActions} />}
            <SidebarRootContextMenu actions={contextMenuActions}>
              <div className="min-h-12 flex-1">
                {tree.length === 0 && (
                  <p className="px-2 text-ui text-subtle-foreground">
                    {t("sidebar.emptyTree", { rootLabel })}
                  </p>
                )}
              </div>
            </SidebarRootContextMenu>
          </div>
        </div>
      </div>
      <div
        role="separator"
        aria-label={t("sidebar.resize")}
        aria-orientation="vertical"
        aria-valuemax={MAX_SIDEBAR_WIDTH}
        aria-valuemin={MIN_SIDEBAR_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={-1}
        onDoubleClick={resetSidebarWidth}
        onPointerDown={handleSidebarResizeStart}
        className={`absolute inset-y-0 right-0 block w-2 translate-x-1/2 cursor-col-resize touch-none transition-colors hover:bg-info/30 ${
          isResizingSidebar ? "bg-info/30" : ""
        }`}
      />
    </aside>
  );
}
