"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FileBrowserStoreProvider } from "./file-browser/store/context";
import { getIsDesktopViewport } from "./file-browser/store/utils";
import { resolveInitialSelectedFolderPath } from "@/lib/file-browser-initial-selection";
import { Shell } from "./file-browser/Shell";
import type {
  AutoSaveResolver,
  DeleteDescriptionResolver,
  ExternalSelection,
  FileBrowserConfig,
} from "./file-browser/store/types";

interface FileBrowserPageProps {
  apiBasePath: string;
  autoSave?: AutoSaveResolver;
  embedded?: boolean;
  externalSelection?: ExternalSelection | null;
  folderPanel?: (props: { path: string }) => ReactNode;
  initialSelectedFolderPath?: string;
  logicalRootPath: string;
  getDeleteDescription?: DeleteDescriptionResolver;
  onStartChatFromFolder?: (path: string) => void;
  onPathsDeleted?: (paths: string[]) => void;
  onFolderCreated?: (createdPath: string, parentPath: string) => void;
  renderCreateExtra?: (ctx: { type: "file" | "folder"; parentPath: string | null }) => ReactNode;
  /**
   * Fires whenever the user's selection in the browser changes: the file
   * currently displayed, the folder whose contents the browser is showing,
   * and any multi-select set in the tree. Used by hosts (e.g. the workspace
   * `ProjectsWidget`) that need to mirror selection elsewhere — the browser
   * stays the source of truth.
   */
  onSelectionChange?: (selection: {
    selectedPath: string | null;
    currentFolderPath: string | null;
    selectedTreePaths: string[];
  }) => void;
  rootLabel: string;
  rootPanelTrigger?: boolean;
  selectInitialFolderOnMobile?: boolean;
  sidebarHeading?: string;
  searchPlaceholder: string;
  title: string;
}

export function FileBrowserPage({
  apiBasePath,
  autoSave,
  embedded = false,
  externalSelection,
  folderPanel,
  initialSelectedFolderPath,
  logicalRootPath,
  getDeleteDescription,
  onStartChatFromFolder,
  onPathsDeleted,
  onFolderCreated,
  renderCreateExtra,
  onSelectionChange,
  rootLabel,
  rootPanelTrigger = false,
  selectInitialFolderOnMobile = true,
  sidebarHeading,
  searchPlaceholder,
  title,
}: FileBrowserPageProps) {
  // `title` is part of the public contract but rendered upstream — keep the
  // prop so callers don't break, but don't reference it here.
  void title;

  const { t } = useTranslation("files");
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [effectiveInitialSelectedFolderPath] = useState(() => {
    // If the URL already targets something below the logical root (a deep
    // file or folder), useUrlSelectionSync will resolve and load it; don't
    // pre-populate selectedFolderPath here or the folder dashboard flashes
    // briefly before the real selection lands.
    const routePathRelative = location.pathname
      .replace(new RegExp(`^/${logicalRootPath}/?`), "")
      .replace(/^\/+|\/+$/g, "");
    if (!embedded && routePathRelative) return null;

    return resolveInitialSelectedFolderPath({
      initialSelectedFolderPath,
      isDesktopViewport: getIsDesktopViewport(),
      selectInitialFolderOnMobile,
    });
  });

  // Snapshot accessors so the store can read the current URL without needing
  // a re-render to update an internal ref. The factory captures these once;
  // we keep them stable by using `useCallback` keyed on the snapshot deps.
  const getRouteSnapshot = useCallback(
    () => ({
      pathname: location.pathname,
      search: location.search,
      hash: location.hash,
    }),
    [location.hash, location.pathname, location.search],
  );

  const config: FileBrowserConfig = useMemo(
    () => ({
      apiBasePath,
      logicalRootPath,
      rootLabel,
      autoSave,
      initialSelectedFolderPath: effectiveInitialSelectedFolderPath,
      queryClient,
      navigate,
      getRouteSnapshot,
      t,
      embedded,
      getDeleteDescription,
      onStartChatFromFolder,
      onPathsDeleted,
      onFolderCreated,
      renderCreateExtra,
      onSelectionChange,
    }),
    [
      apiBasePath,
      logicalRootPath,
      rootLabel,
      autoSave,
      effectiveInitialSelectedFolderPath,
      queryClient,
      navigate,
      getRouteSnapshot,
      t,
      embedded,
      getDeleteDescription,
      onStartChatFromFolder,
      onPathsDeleted,
      onFolderCreated,
      renderCreateExtra,
      onSelectionChange,
    ],
  );

  return (
    <FileBrowserStoreProvider config={config}>
      <Shell
        embedded={embedded}
        rootLabel={rootLabel}
        rootPanelTrigger={rootPanelTrigger}
        sidebarHeading={sidebarHeading}
        searchPlaceholder={searchPlaceholder}
        externalSelection={externalSelection}
        onStartChatFromFolder={onStartChatFromFolder}
        onSelectionChange={onSelectionChange}
        folderPanel={folderPanel}
      />
    </FileBrowserStoreProvider>
  );
}
