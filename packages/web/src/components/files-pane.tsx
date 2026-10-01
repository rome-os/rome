"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  File,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FilePlus,
  FileText,
  FileVideo,
  Folder,
  FolderPlus,
  FolderUp,
  LayoutGrid,
  List,
  Ellipsis,
  Plus,
  Search,
  Upload,
  type LucideIcon,
} from "lucide-react";
import { Spinner } from "@rome-os/ui/spinner";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useFileBrowserStore,
  useFileBrowserStoreApi,
} from "@/components/file-browser/store/context";
import { findDirectoryTreeNode } from "@/components/file-browser/store/utils";
import { useLongPressMenu } from "@/hooks/use-long-press-menu";
import { cn } from "@/lib/utils";
import type { FileBrowserTreeNode } from "@/lib/file-browser-tree";
import { FileActionSheet, type ContextMenuActions } from "@/components/file-browser/ContextMenu";

export type FilesPaneNode = Pick<FileBrowserTreeNode, "name" | "path" | "type">;

const VIEW_STORAGE_KEY = "rome:files-pane:view";

function readPersistedView(): "list" | "grid" {
  try {
    const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
    if (stored === "list" || stored === "grid") return stored;
  } catch {
    // localStorage unavailable; ignore.
  }
  return "list";
}

function persistView(view: "list" | "grid"): void {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // ignore
  }
}

function fileIconFor(name: string): LucideIcon {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "apng"].includes(ext)) return FileImage;
  if (["mp4", "mov", "m4v", "ogv", "webm"].includes(ext)) return FileVideo;
  if (["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"].includes(ext))
    return FileAudio;
  if (["pdf", "docx", "md", "mdx", "txt"].includes(ext)) return FileText;
  if (ext === "json") return FileJson;
  if (
    [
      "yaml",
      "yml",
      "ts",
      "tsx",
      "js",
      "jsx",
      "mjs",
      "cjs",
      "css",
      "scss",
      "html",
      "py",
      "rs",
      "go",
      "toml",
      "sh",
      "lock",
    ].includes(ext)
  )
    return FileCode2;
  return File;
}

function sortFileNodes(nodes: FilesPaneNode[]): FilesPaneNode[] {
  return [...nodes].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function getBreadcrumbChain(path: string, logicalRootPath: string): string[] {
  if (path === logicalRootPath || !path.startsWith(`${logicalRootPath}/`)) {
    return [logicalRootPath];
  }
  const relativePath = path.slice(logicalRootPath.length + 1);
  const segments = relativePath.split("/").filter(Boolean);
  const chain = [logicalRootPath];
  for (let i = 0; i < segments.length; i += 1) {
    chain.push(`${logicalRootPath}/${segments.slice(0, i + 1).join("/")}`);
  }
  return chain;
}

function getCrumbLabel(crumbPath: string): string {
  return crumbPath.split("/").pop() ?? crumbPath;
}

interface FilesPaneProps {
  className?: string;
  /**
   * Placeholder text for the search input. Passed in by the host (Shell), so
   * FilesPane doesn't need to know about specific logical-root names.
   */
  searchPlaceholder: string;
  contextMenuActions: ContextMenuActions;
}

export function FilesPane({ className, searchPlaceholder, contextMenuActions }: FilesPaneProps) {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const logicalRootPath = useFileBrowserStore((s) => s.config.logicalRootPath);
  const drillPath = useFileBrowserStore((s) => s.ui.filesPaneDrillPath);
  const treeNodes = useFileBrowserStore((s) => s.tree.nodes);
  const selectedFolderPath = useFileBrowserStore((s) => s.selection.selectedFolderPath);
  const path = drillPath ?? logicalRootPath;

  // Mirror the canonical `selectedFolderPath` into the drill path: keeps the
  // navigator aligned with whatever URL / external-selection / explicit
  // affordance most recently wrote a folder. Mounting without a drill path
  // also seeds it here (so direct URLs land on the right folder).
  useEffect(() => {
    if (selectedFolderPath) {
      if (store.getState().ui.filesPaneDrillPath !== selectedFolderPath) {
        store.getState().ui.setFilesPaneDrillPath(selectedFolderPath);
      }
      return;
    }
    if (store.getState().ui.filesPaneDrillPath === null) {
      store.getState().ui.setFilesPaneDrillPath(logicalRootPath);
    }
  }, [logicalRootPath, selectedFolderPath, store]);

  const setPath = useCallback(
    (next: string) => {
      store.getState().ui.setFilesPaneDrillPath(next);
      // Drilling loads `next`'s children into the tree; mark the path as
      // expanded too so `loadRoot({ preserveExpandedChildren: true })` (run
      // by the SSE watcher on any filesystem event) keeps those children
      // instead of wiping them. Without this, any SSE refresh after a
      // drill collapses the pane to "Nothing here yet".
      store.getState().tree.expandAncestors(next, { includePath: true });
    },
    [store],
  );

  const [view, setViewState] = useState<"list" | "grid">(() => readPersistedView());
  const [actionState, setActionState] = useState<{
    node: FilesPaneNode;
    paths: string[];
  } | null>(null);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const setView = useCallback((next: "list" | "grid") => {
    setViewState(next);
    persistView(next);
  }, []);

  const openActions = useCallback(
    (node: FilesPaneNode) => {
      const paths = store.getState().selection.prepareContextMenu(node);
      setActionState({ node, paths });
    },
    [store],
  );

  // Tree slice is the source of truth: mutations + watch updates both flow
  // through it, so subscribing keeps the pane reactive. loadPath fills cache
  // on first visit; subsequent re-entries hit the cache without a fetch.
  useEffect(() => {
    let cancelled = false;
    setError(false);
    setLoaded(false);
    void store
      .getState()
      .tree.loadPath(path)
      .then(() => {
        if (!cancelled) setLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name === "AbortError" || err?.name === "CancelledError") return;
        setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [path, store]);

  const files = useMemo<FilesPaneNode[] | null>(() => {
    if (path === logicalRootPath) {
      return loaded || treeNodes.length > 0
        ? treeNodes.map(({ name, path: p, type }) => ({ name, path: p, type }))
        : null;
    }
    const node = findDirectoryTreeNode(treeNodes, path);
    if (!node?.children) return loaded ? [] : null;
    return node.children.map(({ name, path: p, type }) => ({ name, path: p, type }));
  }, [loaded, logicalRootPath, path, treeNodes]);

  const loading = !loaded && files === null;

  const handleNodeSelect = useCallback(
    (node: FilesPaneNode) => {
      if (node.type === "directory") {
        setPath(node.path);
        return;
      }
      void store.getState().selection.guardedSelectFile(node.path);
    },
    [setPath, store],
  );

  const sorted = useMemo(() => (files ? sortFileNodes(files) : []), [files]);
  const countLabel = files
    ? t("pane.items", { count: sorted.length })
    : loading
      ? t("pane.loading")
      : "";

  const crumbs = useMemo(() => getBreadcrumbChain(path, logicalRootPath), [path, logicalRootPath]);

  return (
    <section className={cn("flex min-h-0 min-w-0 flex-col", className)}>
      <Toolbar searchPlaceholder={searchPlaceholder} />
      <header className="mb-3 flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Breadcrumb>
            <BreadcrumbList className="font-mono text-aux">
              {crumbs.map((crumbPath, i) => {
                const isLast = i === crumbs.length - 1;
                const label = getCrumbLabel(crumbPath);
                return (
                  <Fragment key={crumbPath}>
                    <BreadcrumbItem className="min-w-0">
                      {isLast ? (
                        <BreadcrumbPage className="truncate">{label}</BreadcrumbPage>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPath(crumbPath)}
                          className="truncate rounded-4 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {label}
                        </button>
                      )}
                    </BreadcrumbItem>
                    {!isLast && <BreadcrumbSeparator />}
                  </Fragment>
                );
              })}
            </BreadcrumbList>
          </Breadcrumb>
          <div className="text-aux mt-1 text-subtle-foreground">{countLabel}</div>
        </div>
        <SegmentedControl
          size="sm"
          aria-label={t("pane.viewLabel")}
          value={view}
          onValueChange={(next: string) => setView(next as "list" | "grid")}
          className="shrink-0"
          options={[
            {
              value: "list",
              icon: <List strokeWidth={1.6} />,
              label: <span className="sr-only">{t("pane.listView")}</span>,
            },
            {
              value: "grid",
              icon: <LayoutGrid strokeWidth={1.6} />,
              label: <span className="sr-only">{t("pane.gridView")}</span>,
            },
          ]}
        />
      </header>

      {error ? (
        <div className="mt-2 rounded-8 border border-dashed border-border p-6 text-center text-ui text-subtle-foreground">
          {t("pane.loadFailed")}
        </div>
      ) : loading && sorted.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-8 text-ui text-subtle-foreground">
          <Spinner size="sm" label={t("pane.loadingFiles")} />
          <span aria-hidden>{t("pane.loadingFiles")}</span>
        </div>
      ) : sorted.length === 0 ? (
        <div className="mt-2 rounded-8 border border-dashed border-border p-6 text-center text-ui text-subtle-foreground">
          <div className="mb-1 text-muted-foreground">{t("pane.emptyTitle")}</div>
          <div>{t("pane.emptyDescription")}</div>
        </div>
      ) : view === "grid" ? (
        <div className="grid flex-1 grid-cols-[repeat(auto-fill,minmax(96px,1fr))] content-start gap-1 overflow-auto px-1 py-1">
          {sorted.map((node) => (
            <FileGridCard
              key={node.path}
              node={node}
              onSelect={handleNodeSelect}
              onOpenActions={openActions}
            />
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-auto">
          {sorted.map((node) => (
            <FileRow
              key={node.path}
              node={node}
              onSelect={handleNodeSelect}
              onOpenActions={openActions}
              actions={contextMenuActions}
            />
          ))}
        </div>
      )}
      {actionState && (
        <FileActionSheet
          open
          title={contextMenuActions.labelActionsFor(actionState.node.name)}
          closeLabel={contextMenuActions.labelCloseActions}
          kind={actionState.node.type}
          path={actionState.node.path}
          paths={actionState.paths}
          actions={contextMenuActions}
          onClose={() => setActionState(null)}
        />
      )}
    </section>
  );
}

function Toolbar({ searchPlaceholder }: { searchPlaceholder: string }) {
  const { t } = useTranslation("files");
  const store = useFileBrowserStoreApi();
  const searchQuery = useFileBrowserStore((s) => s.ui.searchQuery);
  const creating = useFileBrowserStore((s) => s.ui.creating);

  return (
    <div className="mb-3 flex shrink-0 items-center gap-2">
      <div className="relative flex flex-1 items-center">
        <Search
          size={14}
          strokeWidth={1.8}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 text-subtle-foreground"
        />
        <Input
          type="text"
          placeholder={searchPlaceholder}
          value={searchQuery}
          onChange={(event) => store.getState().ui.setSearchQuery(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && void store.getState().ui.doSearch()}
          className="flex-1 pl-8"
          aria-label={t("header.search")}
        />
      </div>
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
          <DropdownMenuItem
            onSelect={() => {
              const target =
                store.getState().ui.filesPaneDrillPath ?? store.getState().config.logicalRootPath;
              store.getState().ui.triggerUploadForFolder(target);
            }}
          >
            <Upload size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>{t("contextMenu.uploadFiles")}</span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              const target =
                store.getState().ui.filesPaneDrillPath ?? store.getState().config.logicalRootPath;
              store.getState().ui.triggerFolderUploadForFolder(target);
            }}
          >
            <FolderUp size={14} strokeWidth={1.6} aria-hidden="true" />
            <span>{t("contextMenu.uploadFolder")}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

const ROW_CLASS =
  "flex w-full items-center gap-2 rounded-8 px-2 py-1 text-left text-foreground hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const CARD_CLASS =
  "flex min-h-24 w-full flex-col items-center gap-2 rounded-8 px-2 py-3 text-foreground transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function MoreActionsButton({
  node,
  actions,
  onOpenActions,
  className,
}: {
  node: FilesPaneNode;
  actions: ContextMenuActions;
  onOpenActions: (node: FilesPaneNode) => void;
  className?: string;
}) {
  const label = actions.labelMoreActions(node.name);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-lg"
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onOpenActions(node);
      }}
      className={cn(
        "text-muted-foreground hover:bg-surface-muted hover:text-foreground dark:hover:bg-surface-muted",
        className,
      )}
    >
      <Ellipsis className="size-5" aria-hidden />
    </Button>
  );
}

export function FileRow({
  node,
  onSelect,
  onOpenActions,
  actions,
}: {
  node: FilesPaneNode;
  onSelect: (node: FilesPaneNode) => void;
  onOpenActions: (node: FilesPaneNode) => void;
  actions: ContextMenuActions;
}) {
  const isDir = node.type === "directory";
  const Icon = isDir ? Folder : fileIconFor(node.name);
  const longPress = useLongPressMenu({ canOpen: true, onOpen: () => onOpenActions(node) });
  return (
    <div
      className="flex w-full select-none items-stretch rounded-8"
      style={{ WebkitTouchCallout: "none" }}
      onClickCapture={longPress.suppressActivationClick}
      {...longPress.triggerProps}
    >
      <button
        type="button"
        onClick={() => onSelect(node)}
        className={cn(ROW_CLASS, "min-h-11 min-w-0 flex-1")}
      >
        <Icon
          size={16}
          strokeWidth={1.6}
          className={isDir ? "shrink-0 text-brand" : "shrink-0 text-muted-foreground"}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-ui">{node.name}</span>
      </button>
      <MoreActionsButton node={node} actions={actions} onOpenActions={onOpenActions} />
    </div>
  );
}

export function FileGridCard({
  node,
  onSelect,
  onOpenActions,
}: {
  node: FilesPaneNode;
  onSelect: (node: FilesPaneNode) => void;
  onOpenActions: (node: FilesPaneNode) => void;
}) {
  const isDir = node.type === "directory";
  const Icon = isDir ? Folder : fileIconFor(node.name);
  const longPress = useLongPressMenu({ canOpen: true, onOpen: () => onOpenActions(node) });
  return (
    <div
      className="relative select-none rounded-8"
      style={{ WebkitTouchCallout: "none" }}
      onClickCapture={longPress.suppressActivationClick}
      {...longPress.triggerProps}
    >
      <button type="button" onClick={() => onSelect(node)} className={CARD_CLASS}>
        <Icon
          size={32}
          strokeWidth={1.4}
          className={isDir ? "text-brand" : "text-muted-foreground"}
          aria-hidden="true"
        />
        <span className="w-full truncate text-center text-aux">{node.name}</span>
      </button>
    </div>
  );
}

export default FilesPane;
