import {
  useRef,
  useState,
  type DragEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  ChevronRight,
  File,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Ellipsis,
  type LucideIcon,
} from "lucide-react";
import { motion } from "motion/react";
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import { useFileBrowserStore, useFileBrowserStoreApi } from "./store/context";
import type { TreeNode } from "./store/types";
import { TREE_NODE_DRAG_MIME } from "./store/utils";
import { getUploadEntriesFromDataTransfer } from "@/lib/file-browser-upload";
import {
  FileActionDropdownMenuItems,
  TreeRowContextMenuItems,
  type ContextMenuActions,
} from "./ContextMenu";

function getFileIcon(name: string): LucideIcon {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "apng"].includes(extension))
    return FileImage;
  if (["mp4", "mov", "m4v", "ogv", "webm"].includes(extension)) return FileVideo;
  if (["aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav", "weba"].includes(extension))
    return FileAudio;
  if (extension === "pdf" || extension === "docx") return FileText;
  return File;
}

function eventHasFiles(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"));
}

function eventHasTreeNode(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(TREE_NODE_DRAG_MIME));
}

function getDraggedTreeNode(
  dataTransfer: DataTransfer | null,
): Pick<TreeNode, "path" | "type"> | null {
  if (!dataTransfer || !eventHasTreeNode(dataTransfer)) return null;
  try {
    const value = JSON.parse(dataTransfer.getData(TREE_NODE_DRAG_MIME)) as Partial<TreeNode>;
    if (typeof value.path === "string" && (value.type === "file" || value.type === "directory")) {
      return { path: value.path, type: value.type };
    }
  } catch {
    return null;
  }
  return null;
}

interface TreeRowHandlers {
  onSelectFile: (path: string, event: MouseEvent<HTMLButtonElement>) => void;
  onSelectFolder: (path: string, event: MouseEvent<HTMLButtonElement>) => void;
  contextMenuActions: ContextMenuActions;
}

// After a long-press opens the menu, releasing the press must not also
// activate the row. Radix marks the trigger open before the click lands.
function menuJustOpened(event: MouseEvent<HTMLButtonElement>): boolean {
  return event.currentTarget.dataset.state === "open";
}

export function shouldAllowNativeTreeDrag(pointerType: string | null): boolean {
  return pointerType === null || pointerType === "mouse";
}

function TreeRow({
  node,
  level,
  handlers,
}: {
  node: TreeNode;
  level: number;
  handlers: TreeRowHandlers;
}) {
  const store = useFileBrowserStoreApi();
  const expanded = useFileBrowserStore((s) => s.tree.expandedPaths.has(node.path));
  const selected = useFileBrowserStore((s) => s.selection.selectedTreePaths.includes(node.path));
  const [isDragOver, setIsDragOver] = useState(false);
  const [loadingChildren, setLoadingChildren] = useState(false);
  const [menuPaths, setMenuPaths] = useState<string[]>([node.path]);
  const activePointerType = useRef<string | null>(null);

  const handleMenuOpenChange = (open: boolean) => {
    if (!open) return;
    setMenuPaths(store.getState().selection.prepareContextMenu(node));
  };

  const handleNodeDragStart = (event: DragEvent<HTMLButtonElement>) => {
    if (!shouldAllowNativeTreeDrag(activePointerType.current)) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      TREE_NODE_DRAG_MIME,
      JSON.stringify({ path: node.path, type: node.type }),
    );
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    activePointerType.current = event.pointerType;
    if (!shouldAllowNativeTreeDrag(event.pointerType)) {
      // Native HTML drag cancels Radix's touch/pen long-press. Disable it only
      // for this gesture, while preserving mouse drag on hybrid devices.
      event.currentTarget.draggable = false;
    }
  };

  const handlePointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    if (!shouldAllowNativeTreeDrag(event.pointerType)) event.currentTarget.draggable = true;
    activePointerType.current = null;
  };

  const handleFolderDrop = async (event: DragEvent<HTMLButtonElement>, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    store.getState().refs.dragDepth = 0;
    store.getState().ui.setIsDragActive(false);
    const draggedNode = getDraggedTreeNode(event.dataTransfer);
    if (draggedNode) {
      await store.getState().ui.movePathToFolder(draggedNode.path, path);
      return;
    }
    if (eventHasTreeNode(event.dataTransfer)) {
      // dragReadFailed toast
      const { t } = store.getState().config;
      const { toast } = await import("sonner");
      toast.error(t("status.dragReadFailed"));
      return;
    }
    await store
      .getState()
      .ui.uploadFiles(await getUploadEntriesFromDataTransfer(event.dataTransfer), path);
  };

  const menu = (trigger: ReactNode) => (
    <ContextMenu onOpenChange={handleMenuOpenChange}>
      <ContextMenuTrigger asChild>{trigger}</ContextMenuTrigger>
      <ContextMenuContent>
        <TreeRowContextMenuItems
          kind={node.type}
          path={node.path}
          paths={menuPaths}
          actions={handlers.contextMenuActions}
        />
      </ContextMenuContent>
    </ContextMenu>
  );

  const actionsMenu = (
    <DropdownMenu onOpenChange={handleMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <IconButton
          size="sm"
          label={handlers.contextMenuActions.labelMoreActions(node.name)}
          icon={<Ellipsis aria-hidden />}
          className="touch-show touch-target text-subtle-foreground opacity-0 hover:bg-surface-muted hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-[200px]">
        <FileActionDropdownMenuItems
          kind={node.type}
          path={node.path}
          paths={menuPaths}
          actions={handlers.contextMenuActions}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  if (node.type === "directory") {
    const loadChildren = async () => {
      if (node.children !== undefined || loadingChildren) return;
      setLoadingChildren(true);
      try {
        await store.getState().tree.loadFolderChildren(node.path);
      } finally {
        setLoadingChildren(false);
      }
    };

    return (
      <div
        className={`group/row flex w-full items-stretch rounded-8 transition-colors ${
          isDragOver
            ? "bg-info-bg text-info-fg ring-2 ring-ring"
            : selected
              ? "bg-info-bg text-info-fg"
              : "text-foreground hover:bg-surface-muted"
        }`}
      >
        {menu(
          <button
            draggable
            onClick={(event) => {
              if (menuJustOpened(event)) return;
              handlers.onSelectFolder(node.path, event);
              if (event.shiftKey || event.metaKey || event.ctrlKey) return;
              if (!expanded) void loadChildren();
            }}
            onPointerDown={handlePointerDown}
            onPointerUp={handlePointerEnd}
            onPointerCancel={handlePointerEnd}
            onDragStart={handleNodeDragStart}
            onDragEnter={(event) => {
              const hasTreeNode = eventHasTreeNode(event.dataTransfer);
              if (!eventHasFiles(event.dataTransfer) && !hasTreeNode) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = hasTreeNode ? "move" : "copy";
              setIsDragOver(true);
            }}
            onDragOver={(event) => {
              const hasTreeNode = eventHasTreeNode(event.dataTransfer);
              if (!eventHasFiles(event.dataTransfer) && !hasTreeNode) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = hasTreeNode ? "move" : "copy";
              if (!isDragOver) setIsDragOver(true);
            }}
            onDragLeave={(event) => {
              if (!eventHasFiles(event.dataTransfer) && !eventHasTreeNode(event.dataTransfer))
                return;
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              setIsDragOver(false);
            }}
            onDrop={(event) => {
              if (!eventHasFiles(event.dataTransfer) && !eventHasTreeNode(event.dataTransfer))
                return;
              void handleFolderDrop(event, node.path);
            }}
            className="touch-row group flex min-w-0 flex-1 select-none items-center gap-2 rounded-8 px-2 py-2 text-left text-ui md:py-1"
            style={{ paddingLeft: `${level * 16 + 8}px` }}
          >
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-subtle-foreground">
              {loadingChildren ? (
                <span className="text-aux">…</span>
              ) : (
                <ChevronRight className={`h-3 w-3 ${expanded ? "rotate-90" : ""}`} />
              )}
            </span>
            <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-subtle-foreground">
              {expanded ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
            </span>
            <span className="flex-1 truncate">{node.name}</span>
          </button>,
        )}
        {actionsMenu}
      </div>
    );
  }

  const FileIconForRow = getFileIcon(node.name);
  return (
    <div
      className={`group/row flex w-full items-stretch rounded-8 transition-colors ${
        selected ? "bg-info-bg text-info-fg" : "text-foreground hover:bg-surface-muted"
      }`}
    >
      {menu(
        <button
          draggable
          onClick={(event) => {
            if (menuJustOpened(event)) return;
            handlers.onSelectFile(node.path, event);
          }}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
          onDragStart={handleNodeDragStart}
          className="touch-row flex min-w-0 flex-1 select-none items-center gap-2 rounded-8 px-2 py-1 text-left text-ui"
          style={{ paddingLeft: `${level * 16 + 28}px` }}
        >
          <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-subtle-foreground">
            <FileIconForRow className="h-4 w-4" />
          </span>
          <span className="flex-1 truncate">{node.name}</span>
        </button>,
      )}
      {actionsMenu}
    </div>
  );
}

function TreeItem({
  depth,
  node,
  handlers,
}: {
  depth: number;
  node: TreeNode;
  handlers: TreeRowHandlers;
}) {
  const hasChildren = node.type === "directory" && Boolean(node.children?.length);
  const expanded = useFileBrowserStore((s) => s.tree.expandedPaths.has(node.path));
  return (
    <div className="select-none">
      <TreeRow node={node} level={depth} handlers={handlers} />
      {hasChildren && expanded && (
        <div>
          {node.children?.map((child) => (
            <TreeItem key={child.path} depth={depth + 1} node={child} handlers={handlers} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Tree({ contextMenuActions }: { contextMenuActions: ContextMenuActions }) {
  const store = useFileBrowserStoreApi();
  const nodes = useFileBrowserStore((s) => s.tree.nodes);

  const handleSelectFile = async (path: string, event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      store.getState().selection.applyTreeClick(path, event);
      return;
    }
    void store.getState().selection.guardedSelectFile(path);
  };

  const handleSelectFolder = async (path: string, event: MouseEvent<HTMLButtonElement>) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      const next = store.getState().selection.applyTreeClick(path, event);
      if (next.includes(path)) {
        store.setState((s) => ({ selection: { ...s.selection, selectedFolderPath: path } }));
      } else if (store.getState().selection.selectedFolderPath === path) {
        store.setState((s) => ({ selection: { ...s.selection, selectedFolderPath: null } }));
      }
      return;
    }
    if (!(await store.getState().file.resolveUnsavedEditsBeforeLeaving())) return;
    const state = store.getState();
    const wasSelected = state.selection.selectedFolderPath === path;
    const wasExpanded = state.tree.expandedPaths.has(path);
    if (!wasSelected) {
      state.selection.selectFolder(path, { expand: true });
      return;
    }
    state.selection.selectFolder(path, { expand: !wasExpanded });
    if (wasExpanded) {
      const next = new Set(state.tree.expandedPaths);
      next.delete(path);
      state.tree.setExpanded(next);
    }
  };

  const handlers: TreeRowHandlers = {
    onSelectFile: handleSelectFile,
    onSelectFolder: handleSelectFolder,
    contextMenuActions,
  };

  return (
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="w-full"
      initial={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      <div className="p-0">
        {nodes.map((node) => (
          <TreeItem key={node.path} depth={0} node={node} handlers={handlers} />
        ))}
      </div>
    </motion.div>
  );
}
