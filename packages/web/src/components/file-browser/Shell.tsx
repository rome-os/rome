import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type DragEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";
import { Sidebar } from "./Sidebar";
import { Content, HistoryMobileSheet } from "./Content";
import { Dialogs } from "./Dialogs";
import { DropOverlay } from "./DropOverlay";
import { FilesPane } from "@/components/files-pane";
import { FolderPanelTabBar } from "./FolderPanelTabBar";
import { useUrlSelectionSync } from "./hooks/useUrlSelectionSync";
import { useFileBrowserWatch } from "./hooks/useFileBrowserWatch";
import { useBeforeUnloadGuard } from "./hooks/useBeforeUnloadGuard";
import { useDocumentLinkInterceptor } from "./hooks/useDocumentLinkInterceptor";
import { usePageHideKeepalive } from "./hooks/usePageHideKeepalive";
import { useAutoSaveOrchestration } from "./hooks/useAutoSaveOrchestration";
import { useExternalSelection } from "./hooks/useExternalSelection";
import { useContextMenuActions } from "./hooks/useContextMenuActions";
import type { ExternalSelection } from "./store/types";
import { useSelectionChangeBroadcast } from "./hooks/useSelectionChangeBroadcast";
import { useContainerBelowWidth } from "@/lib/useContainerBelowWidth";
import { FILE_BROWSER_TWO_PANE_MIN_WIDTH } from "./store/utils";
import { createFileBrowserEventsUrl, getFileBrowserWatchPaths } from "@/lib/file-browser-watch";
import {
  getUploadEntriesFromDataTransfer,
  getUploadEntriesFromFileList,
} from "@/lib/file-browser-upload";

function eventHasFiles(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

interface ShellProps {
  embedded: boolean;
  rootLabel: string;
  rootPanelTrigger: boolean;
  sidebarHeading?: string;
  searchPlaceholder: string;
  externalSelection?: ExternalSelection | null;
  onStartChatFromFolder?: (path: string) => void;
  onSelectionChange?: (selection: {
    selectedPath: string | null;
    currentFolderPath: string | null;
    selectedTreePaths: string[];
  }) => void;
  folderPanel?: (props: { path: string }) => ReactNode;
}

export function Shell({
  embedded,
  rootLabel,
  rootPanelTrigger,
  sidebarHeading,
  searchPlaceholder,
  externalSelection,
  onStartChatFromFolder,
  onSelectionChange,
  folderPanel,
}: ShellProps) {
  const store = useFileBrowserStoreApi();
  const apiBasePath = useFileBrowserStore((s) => s.config.apiBasePath);
  const logicalRootPath = useFileBrowserStore((s) => s.config.logicalRootPath);
  const expandedPaths = useFileBrowserStore((s) => s.tree.expandedPaths);
  const selectedPath = useFileBrowserStore((s) => s.selection.selectedPath);
  const selectedFolderPath = useFileBrowserStore((s) => s.selection.selectedFolderPath);
  const showHistory = useFileBrowserStore((s) => s.ui.showHistory);
  const showSearch = useFileBrowserStore((s) => s.ui.showSearch);
  const filesPaneDrillPath = useFileBrowserStore((s) => s.ui.filesPaneDrillPath);
  const contextMenuActions = useContextMenuActions({ rootLabel, onStartChatFromFolder });
  // Compact ("below md") is keyed off this browser's *own* width, not the
  // viewport — so an embedded panel (e.g. the workspace Projects widget)
  // collapses to its single-pane layout based on the panel's width, not the
  // window's. `shellRef` is attached to the root `<main>` below.
  const { ref: shellRef, isBelow: isBelowMd } = useContainerBelowWidth<HTMLElement>(
    FILE_BROWSER_TWO_PANE_MIN_WIDTH,
  );

  const watchEventPaths = getFileBrowserWatchPaths(logicalRootPath, expandedPaths, {
    selectedFilePath: selectedPath,
    selectedFolderPath,
    filesPaneDrillPath: isBelowMd ? filesPaneDrillPath : null,
  });
  const watchEventsUrl = createFileBrowserEventsUrl(apiBasePath, watchEventPaths);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const folderInputAttributes = useMemo(
    () =>
      ({
        directory: "",
        webkitdirectory: "",
      }) as InputHTMLAttributes<HTMLInputElement> & {
        directory: string;
        webkitdirectory: string;
      },
    [],
  );

  // Initial tree load.
  useEffect(() => {
    void store.getState().tree.loadRoot();
  }, [store]);

  // Wire the file input ref into the store so context-menu "upload" can fire it.
  useEffect(() => {
    store.getState().refs.fileInput = fileInputRef.current;
    store.getState().refs.folderInput = folderInputRef.current;
    return () => {
      if (store.getState().refs.fileInput === fileInputRef.current) {
        store.getState().refs.fileInput = null;
      }
      if (store.getState().refs.folderInput === folderInputRef.current) {
        store.getState().refs.folderInput = null;
      }
    };
  }, [store]);

  useUrlSelectionSync({ embedded });
  useFileBrowserWatch({ watchEventsUrl });
  useBeforeUnloadGuard();
  useDocumentLinkInterceptor();
  usePageHideKeepalive();
  useAutoSaveOrchestration();
  useExternalSelection(externalSelection);
  useSelectionChangeBroadcast(onSelectionChange);

  const handleUploadSelection = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const files = getUploadEntriesFromFileList(Array.from(event.target.files ?? []));
      event.target.value = "";
      const target = store.getState().refs.pendingUploadTarget ?? undefined;
      store.getState().refs.pendingUploadTarget = null;
      await store.getState().ui.uploadFiles(files, target);
    },
    [store],
  );

  const handleDragEnter = (event: DragEvent<HTMLElement>) => {
    if (!eventHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    store.getState().refs.dragDepth += 1;
    store.getState().ui.setIsDragActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLElement>) => {
    if (!eventHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!store.getState().ui.isDragActive) {
      store.getState().ui.setIsDragActive(true);
    }
  };

  const handleDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!eventHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    const refs = store.getState().refs;
    refs.dragDepth = Math.max(refs.dragDepth - 1, 0);
    if (refs.dragDepth === 0) {
      store.getState().ui.setIsDragActive(false);
    }
  };

  const handleDrop = async (event: DragEvent<HTMLElement>) => {
    if (!eventHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    store.getState().refs.dragDepth = 0;
    store.getState().ui.setIsDragActive(false);
    await store
      .getState()
      .ui.uploadFiles(await getUploadEntriesFromDataTransfer(event.dataTransfer));
  };

  const hasFolderDashboard = Boolean(folderPanel);
  // On sm, Content overlays the navigator (FilesPane) when any of these is set.
  const contentActive = Boolean(
    selectedPath || showSearch || (hasFolderDashboard && selectedFolderPath),
  );

  return (
    <main
      ref={shellRef}
      // `@container/fb` makes this the query container for the file browser, so
      // descendants can switch on the panel's own width via `@min-[…]/fb:`
      // variants — the CSS counterpart to the JS `isBelowMd` above, both keyed
      // to this same element at the same breakpoint.
      className={`@container/fb relative flex flex-col bg-surface-muted ${
        embedded ? "h-full" : "h-[var(--rome-mobile-content-height)] md:h-dvh"
      }`}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadSelection}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleUploadSelection}
        {...folderInputAttributes}
      />
      {isBelowMd && hasFolderDashboard && (
        <div className="flex shrink-0 items-center border-b border-border bg-surface px-3 py-2">
          <FolderPanelTabBar />
        </div>
      )}
      <div className="flex flex-1 overflow-hidden">
        {isBelowMd ? (
          <FilesPane
            className={`${contentActive ? "hidden" : "flex"} w-full flex-1 bg-surface p-4`}
            searchPlaceholder={searchPlaceholder}
            contextMenuActions={contextMenuActions}
          />
        ) : (
          <Sidebar
            embedded={embedded}
            rootLabel={rootLabel}
            rootPanelTrigger={rootPanelTrigger}
            sidebarHeading={sidebarHeading}
            searchPlaceholder={searchPlaceholder}
            contextMenuActions={contextMenuActions}
          />
        )}
        <Content folderPanel={folderPanel} />
      </div>
      {showHistory && <HistoryMobileSheet />}
      <DropOverlay rootLabel={rootLabel} />
      <Dialogs />
    </main>
  );
}
