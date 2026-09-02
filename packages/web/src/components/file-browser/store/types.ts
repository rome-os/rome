import type { TFunction } from "i18next";
import type { QueryClient } from "@tanstack/react-query";
import type { MouseEvent, ReactNode } from "react";
import type { FileBrowserTreeNode } from "@/lib/file-browser-tree";
import type { FileSaveBaselineSequences } from "@/lib/file-save-baseline";
import type { FileBrowserWatchEvent } from "@/lib/file-browser-watch";
import type { FileBrowserUploadEntry } from "@/lib/file-browser-upload";

export type TreeNode = FileBrowserTreeNode;

export interface HistoryEntry {
  date: string;
  hash: string;
  message: string;
}

export interface SearchResult {
  content: string;
  file: string;
  line: number;
}

export interface BrowserFile {
  assetUrl: string | null;
  content: string | null;
  editable: boolean;
  kind: "text" | "image" | "video" | "audio" | "pdf" | "docx" | "binary";
  mimeType: string;
  path: string;
  size: number;
}

export type ResolveResult =
  | {
      type: "file";
      path: string;
      kind: BrowserFile["kind"];
      mimeType: string;
      editable: boolean;
      size: number;
      assetUrl: string | null;
    }
  | { type: "directory"; path: string }
  | { type: "missing"; path: string };

/** A selection pushed in by an embedder (e.g. workspace ProjectsWidget). */
export interface ExternalSelection {
  path: string;
  type: "file" | "directory";
}

export interface AutoSavePolicy {
  commit?: boolean;
  delayMs?: number;
}

export type AutoSaveResolver = (file: BrowserFile) => AutoSavePolicy | false | null | undefined;

export interface LoadFileOptions {
  preserveDisplayedContent?: boolean;
  preserveTreeSelection?: boolean;
  syncUrl?: boolean;
}

export type LoadFileResult = "loaded" | "missing" | "failed";

export interface LoadTreeOptions {
  preserveExpandedChildren?: boolean;
}

export interface SelfOriginatedWatchWrite {
  expiresAt: number;
  remainingEvents: number;
  startedAt: number;
}

export type NameDialogState =
  | {
      confirmLabel: string;
      description: string;
      error?: string | null;
      initialValue: string;
      inputLabel: string;
      mode: "create";
      parentPath: string;
      title: string;
      type: "file" | "folder";
    }
  | {
      confirmLabel: string;
      currentName: string;
      description: string;
      error?: string | null;
      initialValue: string;
      inputLabel: string;
      mode: "rename";
      path: string;
      title: string;
    };

export interface DeleteConfirmState {
  paths: string[];
  title: string;
  description: string;
}

/**
 * Destination picker for "Move to…" — the layout-independent counterpart to
 * tree drag/drop, which only exists once the browser panel is wide enough to
 * render the Sidebar. Singular by design: the picker derives its title, start
 * folder, conflict check and self/descendant rules from one item, so a plural
 * contract would advertise batch support the UI does not implement.
 */
export interface MoveDialogState {
  path: string;
  /** Folder the picker is currently showing. "Move here" targets this path. */
  currentPath: string;
}

export interface DeleteDescriptionEntry {
  path: string;
  type: TreeNode["type"] | null;
}

export type DeleteDescriptionResolver = (ctx: {
  defaultDescription: string;
  entries: DeleteDescriptionEntry[];
  paths: string[];
}) => string | null | undefined;

export interface FileBrowserConfig {
  apiBasePath: string;
  logicalRootPath: string;
  rootLabel: string;
  autoSave?: AutoSaveResolver;
  initialSelectedFolderPath: string | null;
  queryClient: QueryClient;
  navigate: (to: string, options?: { replace?: boolean }) => void;
  getRouteSnapshot: () => { pathname: string; search: string; hash: string };
  t: TFunction;
  embedded: boolean;
  getDeleteDescription?: DeleteDescriptionResolver;
  onStartChatFromFolder?: (path: string) => void;
  onPathsDeleted?: (paths: string[]) => void;
  /** Fired after a folder is created. Lets a host (e.g. the projects page) act on
   * a brand-new top-level project — e.g. proceed with a sync connection the user
   * opted into via `renderCreateExtra`. */
  onFolderCreated?: (createdPath: string, parentPath: string) => void;
  /** Extra content rendered inside the create dialog (e.g. a sync-source picker
   * for new folders). `parentPath` is the create target's parent (may be null
   * when creating at the root). */
  renderCreateExtra?: (ctx: { type: "file" | "folder"; parentPath: string | null }) => ReactNode;
  onSelectionChange?: (selection: {
    selectedPath: string | null;
    currentFolderPath: string | null;
    selectedTreePaths: string[];
  }) => void;
}

export type TreeClickModifiers = Pick<
  MouseEvent<HTMLButtonElement>,
  "ctrlKey" | "metaKey" | "shiftKey"
>;

export interface TreeSlice {
  nodes: TreeNode[];
  expandedPaths: Set<string>;
  setExpanded(paths: Set<string>): void;
  expandAncestors(path: string | null, opts?: { includePath?: boolean }): void;
  loadRoot(opts?: LoadTreeOptions): Promise<TreeNode[]>;
  loadFolderChildren(path: string): Promise<void>;
  loadPath(path: string, opts?: { force?: boolean }): Promise<TreeNode[]>;
  refreshAncestors(path: string): Promise<void>;
  loadDirectoryAncestors(path: string): Promise<void>;
  reset(): void;
}

export interface SelectionSlice {
  selectedPath: string | null;
  selectedFolderPath: string | null;
  selectedTreePaths: string[];
  _anchorPath: string | null;
  setSelectedTreePaths(paths: string[]): void;
  selectFile(path: string, opts?: LoadFileOptions): Promise<LoadFileResult>;
  selectFolder(path: string | null, opts?: { expand?: boolean; syncUrl?: boolean }): void;
  guardedSelectFile(path: string, opts?: LoadFileOptions): Promise<boolean>;
  guardedSelectFolder(
    path: string | null,
    opts?: { expand?: boolean; syncUrl?: boolean },
  ): Promise<boolean>;
  applyTreeClick(path: string, mods: TreeClickModifiers): string[];
  clearMultiSelect(): void;
  prepareContextMenu(node: Pick<TreeNode, "path" | "type">): string[];
  navigateToPath(path: string | null, opts?: { replace?: boolean }): void;
}

export interface FileSlice {
  selectedFile: BrowserFile | null;
  content: string;
  committedContent: string;
  lastDiskContent: string;
  loadingFile: boolean;
  saving: boolean;
  autoSaveState: "idle" | "pending" | "saving" | "saved" | "error";
  textViewMode: "edit" | "preview";
  _fileLoadRequestId: number;
  _autoSaveRequestId: number;
  _autoSaveAbortController: AbortController | null;
  _autoSaveTimeoutId: number | null;
  _nextSaveSequence: number;
  _saveBaselineSequencesByPath: Map<string, FileSaveBaselineSequences>;
  _selfOriginatedWatchWrites: Map<string, SelfOriginatedWatchWrite>;
  _manualSaveInFlight: Promise<void> | null;
  _autoSaveCanRecover: boolean;
  _suppressNextBeforeUnload: boolean;
  setContent(next: string): void;
  setTextViewMode(mode: "edit" | "preview"): void;
  toggleTextViewMode(): void;
  loadFile(path: string, opts?: LoadFileOptions): Promise<LoadFileResult>;
  clearFile(): void;
  saveFile(): Promise<void>;
  flushAutoSave(): Promise<boolean>;
  resolveUnsavedEditsBeforeLeaving(): Promise<boolean>;
  rememberSelfOriginatedWatchWrite(path: string): void;
  isSelfOriginatedWatchEvent(event: FileBrowserWatchEvent): boolean;
  resolveAutoSavePolicy(file: BrowserFile): AutoSavePolicy | null;
  writeFileContent(args: {
    commit: boolean;
    contentToSave: string;
    path: string;
    signal?: AbortSignal;
  }): Promise<{ aborted?: boolean; error?: string; message?: string; success: boolean }>;
  hasUnsavedEdits(): boolean;
  setSuppressNextBeforeUnload(value: boolean): void;
}

export interface UiSlice {
  history: HistoryEntry[];
  loadingHistory: boolean;
  showHistory: boolean;
  searchQuery: string;
  searchResults: SearchResult[];
  searching: boolean;
  showSearch: boolean;
  nameDialog: NameDialogState | null;
  deleteConfirm: DeleteConfirmState | null;
  moveDialog: MoveDialogState | null;
  discardChangesConfirmOpen: boolean;
  isDragActive: boolean;
  sidebarWidth: number;
  isResizingSidebar: boolean;
  creating: boolean;
  deleting: boolean;
  moving: boolean;
  renaming: boolean;
  uploading: boolean;
  /**
   * The folder that the sm-only `FilesPane` navigator is currently showing
   * (drilled into). Lifted into the store so the on-screen `[Overview |
   * Files]` segment in the folder-panel header can read which folder the
   * dashboard should open, and so the navigator can restore its position
   * after the user closes the dashboard. Always null on md+ (Sidebar owns
   * navigation there).
   */
  filesPaneDrillPath: string | null;
  setSearchQuery(value: string): void;
  setShowSearch(value: boolean): void;
  setShowHistory(value: boolean): void;
  setNameDialog(value: NameDialogState | null): void;
  setDeleteConfirm(value: DeleteConfirmState | null): void;
  setMoveDialog(value: MoveDialogState | null): void;
  resolveDiscardChangesConfirm(discard: boolean): void;
  setIsDragActive(value: boolean): void;
  setSidebarWidth(value: number): void;
  setIsResizingSidebar(value: boolean): void;
  setFilesPaneDrillPath(value: string | null): void;
  loadHistory(): Promise<void>;
  doSearch(): Promise<void>;
  uploadFiles(files: FileBrowserUploadEntry[], targetPathOverride?: string): Promise<void>;
  createPath(type: "file" | "folder", parentPath?: string): void;
  createPathWithName(type: "file" | "folder", parentPath: string, name: string): Promise<void>;
  renamePath(path: string): void;
  renamePathWithName(path: string, currentName: string, nextName: string): Promise<void>;
  requestDeletePaths(paths: string[]): void;
  deletePaths(paths: string[]): Promise<void>;
  downloadPaths(paths: string[]): void;
  requestMovePath(path: string): void;
  /** Resolves true when the item actually moved, so dialog callers know whether to close. */
  movePathToFolder(path: string, parentPath: string): Promise<boolean>;
  copyPath(text: string): Promise<void>;
  triggerUploadForFolder(path: string): void;
  triggerFolderUploadForFolder(path: string): void;
  handleNameDialogConfirm(rawName: string): Promise<void>;
}

export interface WatchSlice {
  clearDeletedSelection(deletedPath: string): void;
}

export interface FileBrowserState {
  config: FileBrowserConfig;
  tree: TreeSlice;
  selection: SelectionSlice;
  file: FileSlice;
  ui: UiSlice;
  watch: WatchSlice;
  /**
   * Imperative ref-bag shared by hooks for things zustand can't store:
   * the upload <input>'s ref, the URL-bookkeeping ref, the resize anchor.
   */
  refs: {
    fileInput: HTMLInputElement | null;
    folderInput: HTMLInputElement | null;
    pendingUploadTarget: string | null;
    discardChangesResolver: ((discard: boolean) => void) | null;
    acceptedBrowserPath: string;
    sidebarResize: { startWidth: number; startX: number } | null;
    dragDepth: number;
  };
}
