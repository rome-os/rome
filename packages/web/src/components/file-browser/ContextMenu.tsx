import type { ReactNode } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Copy,
  Download,
  FilePlus,
  FolderInput,
  FolderPlus,
  FolderUp,
  MessageCircle,
  Pencil,
  Trash2,
  Upload,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  dropdownMenuItemVariants,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import type { TreeNode } from "./store/types";

export interface ContextMenuActions {
  creating: boolean;
  renaming: boolean;
  moving: boolean;
  deleting: boolean;
  logicalRootPath: string;
  rootLabel: string;
  canStartChatFromFolder: boolean;
  onCreatePath: (type: "file" | "folder", parentPath: string) => void;
  onCopyPath: (text: string) => void;
  /** The node's kind, or null when the path is not in the loaded tree. */
  getPathKind: (path: string) => TreeNode["type"] | null;
  onDownloadPaths: (paths: string[]) => void;
  onUploadForFolder: (path: string) => void;
  onUploadFolderForFolder: (path: string) => void;
  onStartChatHere: (path: string) => void;
  onRenamePath: (path: string) => void;
  onRequestMovePath: (path: string) => void;
  onRequestDeletePaths: (paths: string[]) => void;
  labelSelectedItems: (count: number) => string;
  labelNewFile: string;
  labelNewFolder: string;
  labelCopyPath: string;
  labelCopyPaths: string;
  labelDownload: string;
  labelUploadFiles: string;
  labelUploadFolder: string;
  labelStartChatHere: string;
  labelRename: string;
  labelMoveTo: string;
  labelDelete: string;
  labelMoreActions: (name: string) => string;
  labelActionsFor: (name: string) => string;
  labelCloseActions: string;
}

export type FileActionMenuEntry =
  | { type: "label"; key: string; label: string }
  | { type: "separator"; key: string }
  | {
      type: "action";
      key: string;
      label: string;
      icon: LucideIcon;
      disabled?: boolean;
      destructive?: boolean;
      onSelect: () => void;
    };

/**
 * The text "Copy path" writes for one node: the root label for the logical
 * root, a trailing slash for a directory, and the bare path for a file.
 */
export function formatCopyPath(
  path: string,
  kind: TreeNode["type"] | null,
  actions: Pick<ContextMenuActions, "logicalRootPath" | "rootLabel">,
): string {
  if (path === actions.logicalRootPath) return actions.rootLabel;
  return kind === "directory" ? `${path}/` : path;
}

export function getFileActionMenuEntries({
  kind,
  path,
  paths,
  actions,
}: {
  kind: TreeNode["type"];
  path: string;
  paths: string[];
  actions: ContextMenuActions;
}): FileActionMenuEntry[] {
  const isDirectory = kind === "directory";
  const isSingle = paths.length === 1;
  const isRoot = path === actions.logicalRootPath;
  const entries: FileActionMenuEntry[] = [];

  if (paths.length > 1) {
    entries.push({
      type: "label",
      key: "selection",
      label: actions.labelSelectedItems(paths.length),
    });
    entries.push({ type: "separator", key: "selection-separator" });
  }
  if (isDirectory && isSingle) {
    entries.push({
      type: "action",
      key: "new-file",
      label: actions.labelNewFile,
      icon: FilePlus,
      disabled: actions.creating,
      onSelect: () => actions.onCreatePath("file", path),
    });
    entries.push({
      type: "action",
      key: "new-folder",
      label: actions.labelNewFolder,
      icon: FolderPlus,
      disabled: actions.creating,
      onSelect: () => actions.onCreatePath("folder", path),
    });
  }
  entries.push({
    type: "action",
    key: "copy-path",
    label: isSingle ? actions.labelCopyPath : actions.labelCopyPaths,
    icon: Copy,
    onSelect: () =>
      actions.onCopyPath(
        paths
          .map((candidate) =>
            formatCopyPath(
              candidate,
              candidate === path ? kind : actions.getPathKind(candidate),
              actions,
            ),
          )
          .join("\n"),
      ),
  });
  entries.push({
    type: "action",
    key: "download",
    label: actions.labelDownload,
    icon: Download,
    onSelect: () => actions.onDownloadPaths(paths),
  });
  if (isDirectory && isSingle) {
    entries.push({
      type: "action",
      key: "upload-files",
      label: actions.labelUploadFiles,
      icon: Upload,
      onSelect: () => actions.onUploadForFolder(path),
    });
    entries.push({
      type: "action",
      key: "upload-folder",
      label: actions.labelUploadFolder,
      icon: FolderUp,
      onSelect: () => actions.onUploadFolderForFolder(path),
    });
  }
  if (actions.canStartChatFromFolder && isDirectory && !isRoot && isSingle) {
    entries.push({
      type: "action",
      key: "start-chat",
      label: actions.labelStartChatHere,
      icon: MessageCircle,
      onSelect: () => actions.onStartChatHere(path),
    });
  }
  if (!isRoot && isSingle) {
    entries.push({
      type: "action",
      key: "rename",
      label: actions.labelRename,
      icon: Pencil,
      disabled: actions.renaming,
      onSelect: () => actions.onRenamePath(path),
    });
    // Layout-independent counterpart to tree drag/drop, which only exists once
    // the browser panel is wide enough to render the Sidebar.
    entries.push({
      type: "action",
      key: "move-to",
      label: actions.labelMoveTo,
      icon: FolderInput,
      disabled: actions.moving,
      onSelect: () => actions.onRequestMovePath(path),
    });
  }
  if (paths.every((candidate) => candidate !== actions.logicalRootPath)) {
    entries.push({ type: "separator", key: "destructive-separator" });
    entries.push({
      type: "action",
      key: "delete",
      label: actions.labelDelete,
      icon: Trash2,
      disabled: actions.deleting,
      destructive: true,
      onSelect: () => actions.onRequestDeletePaths(paths),
    });
  }
  return entries;
}

export function TreeRowContextMenuItems(props: {
  kind: TreeNode["type"];
  path: string;
  paths: string[];
  actions: ContextMenuActions;
}) {
  return getFileActionMenuEntries(props).map((entry) => {
    if (entry.type === "label") {
      return <ContextMenuLabel key={entry.key}>{entry.label}</ContextMenuLabel>;
    }
    if (entry.type === "separator") return <ContextMenuSeparator key={entry.key} />;
    const Icon = entry.icon;
    return (
      <ContextMenuItem
        key={entry.key}
        disabled={entry.disabled}
        variant={entry.destructive ? "destructive" : "default"}
        onSelect={entry.onSelect}
        className="touch-action-item"
      >
        <Icon aria-hidden />
        <span>{entry.label}</span>
      </ContextMenuItem>
    );
  });
}

type FileActionEntry = Extract<FileActionMenuEntry, { type: "action" }>;

/**
 * The dropdown and the sheet can't share an element — Radix menu semantics
 * only work inside a menu root — so they share this body plus
 * `dropdownMenuItemVariants`. Icon size and color come from that recipe, which
 * is why the icon carries no classes here.
 */
function FileActionItemContent({ entry }: { entry: FileActionEntry }) {
  const Icon = entry.icon;
  return (
    <>
      <Icon aria-hidden />
      <span>{entry.label}</span>
    </>
  );
}

const fileActionItemVariant = (entry: FileActionEntry) =>
  entry.destructive ? ("destructive" as const) : ("default" as const);

export function FileActionDropdownMenuItems(props: {
  kind: TreeNode["type"];
  path: string;
  paths: string[];
  actions: ContextMenuActions;
}) {
  return getFileActionMenuEntries(props).map((entry) => {
    if (entry.type === "label") {
      return <DropdownMenuLabel key={entry.key}>{entry.label}</DropdownMenuLabel>;
    }
    if (entry.type === "separator") return <DropdownMenuSeparator key={entry.key} />;
    return (
      <DropdownMenuItem
        key={entry.key}
        disabled={entry.disabled}
        variant={fileActionItemVariant(entry)}
        onSelect={entry.onSelect}
        className="touch-action-item"
      >
        <FileActionItemContent entry={entry} />
      </DropdownMenuItem>
    );
  });
}

export function FileActionSheet({
  open,
  title,
  closeLabel,
  kind,
  path,
  paths,
  actions,
  onClose,
}: {
  open: boolean;
  title: string;
  closeLabel: string;
  kind: TreeNode["type"];
  path: string;
  paths: string[];
  actions: ContextMenuActions;
  onClose: () => void;
}) {
  const entries = getFileActionMenuEntries({ kind, path, paths, actions });
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="rome-backdrop-fade fixed inset-0 z-50 bg-foreground/40" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="rome-sheet-rise fixed inset-x-0 bottom-0 z-50 flex max-h-[85dvh] flex-col rounded-t-16 border-t border-border bg-surface text-foreground shadow-25 outline-none"
        >
          <div className="flex shrink-0 justify-center pb-1 pt-2" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-border-strong" />
          </div>
          <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-border-subtle px-4 pb-2">
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-section">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-lg"
                aria-label={closeLabel}
                title={closeLabel}
                className="rounded-full text-muted-foreground hover:bg-surface-muted dark:hover:bg-surface-muted"
              >
                <X className="size-5" aria-hidden />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="overflow-y-auto px-3 pb-[max(var(--rome-safe-area-bottom),0.75rem)] pt-2">
            {entries.map((entry) => {
              if (entry.type === "label") {
                return (
                  <div key={entry.key} className="px-3 py-2 text-aux text-muted-foreground">
                    {entry.label}
                  </div>
                );
              }
              if (entry.type === "separator") {
                return <Separator key={entry.key} className="my-2" decorative={false} />;
              }
              return (
                <button
                  key={entry.key}
                  type="button"
                  data-variant={fileActionItemVariant(entry)}
                  disabled={entry.disabled}
                  onClick={() => {
                    onClose();
                    entry.onSelect();
                  }}
                  className={dropdownMenuItemVariants({ size: "touch" })}
                >
                  <FileActionItemContent entry={entry} />
                </button>
              );
            })}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Context menu for the empty-area spacer below the tree. Keeping this trigger
 * as a sibling of row triggers avoids arming nested long-press timers.
 */
export function SidebarRootContextMenu({
  actions,
  children,
}: {
  actions: ContextMenuActions;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          disabled={actions.creating}
          onSelect={() => actions.onCreatePath("file", actions.logicalRootPath)}
        >
          <FilePlus aria-hidden />
          <span>{actions.labelNewFile}</span>
        </ContextMenuItem>
        <ContextMenuItem
          disabled={actions.creating}
          onSelect={() => actions.onCreatePath("folder", actions.logicalRootPath)}
        >
          <FolderPlus aria-hidden />
          <span>{actions.labelNewFolder}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => actions.onUploadForFolder(actions.logicalRootPath)}>
          <Upload aria-hidden />
          <span>{actions.labelUploadFiles}</span>
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => actions.onUploadFolderForFolder(actions.logicalRootPath)}>
          <FolderUp aria-hidden />
          <span>{actions.labelUploadFolder}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
