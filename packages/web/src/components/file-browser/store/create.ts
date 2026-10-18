import { createStore, type StoreApi } from "zustand/vanilla";
import { isCancelledError } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  type FileBrowserTreeNode,
  mergeTreeNodesPreservingLoadedChildren,
  replaceTreeNodeChildren,
} from "@/lib/file-browser-tree";
import { getSuccessfulFileSaveBaselineUpdate } from "@/lib/file-save-baseline";
import {
  createFileSaveRequestBody,
  fitsKeepaliveFileSavePayload,
} from "@/lib/file-autosave-keepalive";
import { getFileBrowserPathChangeUpdate } from "@/lib/file-browser-path-change";
import {
  getFileBrowserDirectoryAncestors,
  getFileBrowserUrlPath,
} from "@/lib/file-browser-routing";
import {
  getNextBrowserSelection,
  shouldPreserveDisplayedFileContent,
} from "@/lib/file-browser-selection";
import { getTextPreviewKind } from "@/lib/file-preview";
import type { FileBrowserWatchEvent } from "@/lib/file-browser-watch";
import type {
  BrowserFile,
  FileBrowserConfig,
  FileBrowserState,
  LoadFileOptions,
  LoadFileResult,
  LoadTreeOptions,
  ResolveResult,
} from "./types";
import {
  DEFAULT_AUTOSAVE_DELAY_MS,
  DEFAULT_SIDEBAR_WIDTH,
  FOLDER_TREE_DEPTH,
  INITIAL_TREE_DEPTH,
  SELF_ORIGINATED_WATCH_SUPPRESSION_MS,
  findDirectoryTreeNode,
  findTreeNode,
  getBaseName,
  getChildPath,
  getParentPath,
  getPathDepth,
  getTopLevelActionPaths,
  isPathWithin,
  isValidNewItemName,
  flattenVisibleTreePaths,
} from "./utils";

type TreeNode = FileBrowserTreeNode;

interface UploadResponse {
  error?: string;
  files?: Array<{ path: string; size: number }>;
  message?: string;
}

interface MoveResponse {
  error?: string;
  message?: string;
  path?: string;
}

interface CreateResponse {
  error?: string;
  message?: string;
  path?: string;
}

export type FileBrowserStoreApi = StoreApi<FileBrowserState>;

export function createFileBrowserStore(config: FileBrowserConfig): FileBrowserStoreApi {
  const { apiBasePath, logicalRootPath, queryClient, navigate, getRouteSnapshot, embedded } =
    config;

  const resolveQueryKey = (path: string) =>
    ["file-browser", logicalRootPath, "resolve", path] as const;
  const treeQueryKey = (path: string) => ["file-browser", logicalRootPath, "tree", path] as const;
  const scopeQueryKey = ["file-browser", logicalRootPath] as const;

  async function fetchTree(path: string, depth: number): Promise<TreeNode[]> {
    const params = new URLSearchParams({ depth: String(depth) });
    if (path !== logicalRootPath) {
      params.set("path", path);
    }
    const response = await fetch(`${apiBasePath}/tree?${params.toString()}`);
    const data = (await response.json()) as TreeNode[] | { error?: string };
    if (!response.ok || !Array.isArray(data)) {
      throw new Error("Failed to load tree");
    }
    return data;
  }

  async function fetchResolve(path: string): Promise<ResolveResult> {
    const response = await fetch(`${apiBasePath}/resolve?path=${encodeURIComponent(path)}`);
    const data = (await response.json()) as ResolveResult | { error?: string };
    if (!response.ok || !("type" in data)) {
      throw new Error("Failed to resolve path");
    }
    return data;
  }

  const initialRouteSnapshot = getRouteSnapshot();

  const store = createStore<FileBrowserState>()((set, get) => {
    /**
     * Shared by `rename` and `move`. Mirrors the original
     * `reloadAfterPathChange`: compute new selection state from the path
     * change, refresh ancestors, load the new selected file, navigate URL.
     */
    const reloadAfterPathChange = async (oldPath: string, newPath: string) => {
      const state = get();
      const pathChange = getFileBrowserPathChangeUpdate({
        newPath,
        oldPath,
        selectedFolderPath: state.selection.selectedFolderPath,
        selectedPath: state.selection.selectedPath,
        selectedTreePaths: state.selection.selectedTreePaths,
        selectionAnchorPath: state.selection._anchorPath,
      });

      set((s) => ({
        selection: {
          ...s.selection,
          selectedFolderPath: pathChange.selectedFolderPath,
          selectedTreePaths: pathChange.selectedTreePaths,
        },
        ui: { ...s.ui, showSearch: false },
      }));
      get().selection._anchorPath = pathChange.selectionAnchorPath;

      await get().tree.refreshAncestors(oldPath);
      await get().tree.loadDirectoryAncestors(pathChange.changedPathToReveal);
      if (pathChange.selectedFolderPath) {
        await get().tree.loadPath(pathChange.selectedFolderPath);
      }
      if (pathChange.selectedPath && pathChange.selectedPath !== get().selection.selectedPath) {
        await get().file.loadFile(pathChange.selectedPath, { syncUrl: false });
      } else {
        set((s) => ({
          selection: { ...s.selection, selectedPath: pathChange.selectedPath },
        }));
      }
      if (pathChange.selectedFolderPath) {
        get().tree.expandAncestors(pathChange.selectedFolderPath, { includePath: true });
      }
      get().selection.navigateToPath(pathChange.selectedPath ?? pathChange.selectedFolderPath, {
        replace: true,
      });
    };

    return {
      config,
      refs: {
        fileInput: null,
        folderInput: null,
        pendingUploadTarget: null,
        discardChangesResolver: null,
        acceptedBrowserPath: `${initialRouteSnapshot.pathname}${initialRouteSnapshot.search}${initialRouteSnapshot.hash}`,
        sidebarResize: null,
        dragDepth: 0,
      },

      tree: {
        nodes: [],
        expandedPaths: new Set<string>(),

        setExpanded(paths) {
          set((state) => ({ tree: { ...state.tree, expandedPaths: paths } }));
        },

        expandAncestors(path, opts) {
          if (!path) return;
          set((state) => {
            const next = new Set(state.tree.expandedPaths);
            for (const ancestor of getFileBrowserDirectoryAncestors(path, logicalRootPath)) {
              next.add(ancestor);
            }
            if (opts?.includePath) next.add(path);
            return { tree: { ...state.tree, expandedPaths: next } };
          });
        },

        async loadRoot(opts?: LoadTreeOptions): Promise<TreeNode[]> {
          try {
            // Mark cached entries stale so subsequent fetchQuery calls refetch,
            // but don't cancel in-flight queries (route effect's resolve, etc.) — that
            // would race the initial deep-link mount.
            queryClient.invalidateQueries({ queryKey: scopeQueryKey, refetchType: "none" });
            let nextTree = await fetchTree(logicalRootPath, INITIAL_TREE_DEPTH);
            if (opts?.preserveExpandedChildren) {
              const logicalRootDepth = getPathDepth(logicalRootPath);
              const expandedDirectoryPaths = Array.from(get().tree.expandedPaths)
                .filter((path) => getPathDepth(path) > logicalRootDepth + 1)
                .sort((a, b) => {
                  const depthDelta = getPathDepth(a) - getPathDepth(b);
                  return depthDelta === 0 ? a.localeCompare(b) : depthDelta;
                });
              for (const path of expandedDirectoryPaths) {
                if (!findDirectoryTreeNode(nextTree, path)) continue;
                try {
                  const children = await fetchTree(path, FOLDER_TREE_DEPTH);
                  nextTree = replaceTreeNodeChildren(nextTree, path, children);
                } catch (error) {
                  console.error(`Failed to refresh expanded ${logicalRootPath} folder:`, error);
                }
              }
            }
            set((state) => ({ tree: { ...state.tree, nodes: nextTree } }));
            return nextTree;
          } catch (error) {
            console.error(`Failed to load ${logicalRootPath} tree:`, error);
            set((state) => ({ tree: { ...state.tree, nodes: [] } }));
            return [];
          }
        },

        async loadFolderChildren(path) {
          try {
            const children = await fetchTree(path, FOLDER_TREE_DEPTH);
            set((state) => ({
              tree: {
                ...state.tree,
                nodes: replaceTreeNodeChildren(state.tree.nodes, path, children),
              },
            }));
          } catch (error) {
            console.error(`Failed to load ${logicalRootPath} folder:`, error);
          }
        },

        async loadPath(path, opts) {
          const queryKey = treeQueryKey(path);
          const currentTree = get().tree.nodes;
          if (!opts?.force) {
            if (path === logicalRootPath) {
              if (currentTree.length > 0) return currentTree;
            } else {
              const existing = findDirectoryTreeNode(currentTree, path);
              if (existing?.children) {
                queryClient.setQueryData<TreeNode[]>(queryKey, existing.children);
                return existing.children;
              }
            }
          }

          const children = await queryClient.fetchQuery({
            queryKey,
            queryFn: () => fetchTree(path, FOLDER_TREE_DEPTH),
            staleTime: opts?.force ? 0 : Infinity,
          });
          if (path === logicalRootPath) {
            set((state) => ({
              tree: {
                ...state.tree,
                nodes: mergeTreeNodesPreservingLoadedChildren(children, state.tree.nodes, {
                  preserveChildrenForPaths: state.tree.expandedPaths,
                }),
              },
            }));
          } else {
            set((state) => ({
              tree: {
                ...state.tree,
                nodes: replaceTreeNodeChildren(state.tree.nodes, path, children),
              },
            }));
          }
          return children;
        },

        async refreshAncestors(path) {
          await get().tree.loadPath(logicalRootPath);
          const ancestors = getFileBrowserDirectoryAncestors(path, logicalRootPath);
          for (const ancestor of ancestors) {
            await get().tree.loadPath(ancestor);
          }
        },

        async loadDirectoryAncestors(path) {
          await get().tree.refreshAncestors(path);
          get().tree.expandAncestors(path);
        },

        reset() {
          set((state) => ({ tree: { ...state.tree, nodes: [], expandedPaths: new Set() } }));
        },
      },

      selection: {
        selectedPath: null,
        selectedFolderPath: config.initialSelectedFolderPath,
        selectedTreePaths: config.initialSelectedFolderPath
          ? [config.initialSelectedFolderPath]
          : [],
        _anchorPath: config.initialSelectedFolderPath,

        setSelectedTreePaths(paths) {
          set((state) => ({ selection: { ...state.selection, selectedTreePaths: paths } }));
        },

        navigateToPath(path, opts) {
          if (embedded) return;
          const route = getRouteSnapshot();
          const nextPathname = getFileBrowserUrlPath(logicalRootPath, path, config.routeBasePath);
          const hideSidebar = new URLSearchParams(route.search).get("hideSidebar");
          const nextLocation = hideSidebar === "1" ? `${nextPathname}?hideSidebar=1` : nextPathname;
          get().refs.acceptedBrowserPath = nextPathname;
          if (route.pathname === nextPathname) return;
          navigate(nextLocation, { replace: opts?.replace ?? false });
        },

        async selectFile(path, opts): Promise<LoadFileResult> {
          return get().file.loadFile(path, opts);
        },

        selectFolder(path, opts) {
          const state = get();
          state.selection._anchorPath = path;
          state.file.clearFile();
          set((s) => ({
            selection: {
              ...s.selection,
              selectedTreePaths: path ? [path] : [],
              selectedFolderPath: path,
              selectedPath: null,
            },
            ui: { ...s.ui, showHistory: false, showSearch: false },
          }));
          if (path && opts?.expand) {
            state.tree.expandAncestors(path, { includePath: true });
          }
          if (path && path !== logicalRootPath) {
            void state.tree.loadPath(path).catch((error) => {
              if (isCancelledError(error)) return;
              console.error("Failed to load folder children:", error);
            });
          }
          if (opts?.syncUrl !== false) {
            state.selection.navigateToPath(path);
          }
        },

        async guardedSelectFile(path, opts) {
          if (!(await get().file.resolveUnsavedEditsBeforeLeaving())) return false;
          await get().file.loadFile(path, opts);
          return true;
        },

        async guardedSelectFolder(path, opts) {
          if (!(await get().file.resolveUnsavedEditsBeforeLeaving())) return false;
          get().selection.selectFolder(path, opts);
          return true;
        },

        clearMultiSelect() {
          const state = get();
          const keep = state.selection.selectedPath ?? state.selection.selectedFolderPath;
          state.selection._anchorPath = keep;
          set((s) => ({
            selection: {
              ...s.selection,
              selectedTreePaths: keep ? [keep] : [],
            },
          }));
        },

        applyTreeClick(path, mods) {
          const state = get();
          const orderedPaths = flattenVisibleTreePaths(state.tree.nodes, state.tree.expandedPaths);
          const next = getNextBrowserSelection({
            additive: mods.metaKey || mods.ctrlKey,
            anchorPath: state.selection._anchorPath,
            orderedPaths,
            range: mods.shiftKey,
            selectedPaths: state.selection.selectedTreePaths,
            targetPath: path,
          });
          state.selection._anchorPath = next.anchorPath;
          set((s) => ({ selection: { ...s.selection, selectedTreePaths: next.selectedPaths } }));
          return next.selectedPaths;
        },

        prepareContextMenu(node) {
          const state = get();
          const actionPaths = state.selection.selectedTreePaths.includes(node.path)
            ? state.selection.selectedTreePaths
            : [node.path];
          if (!state.selection.selectedTreePaths.includes(node.path)) {
            state.selection._anchorPath = node.path;
            set((s) => ({ selection: { ...s.selection, selectedTreePaths: [node.path] } }));
          }
          return getTopLevelActionPaths(actionPaths);
        },
      },

      file: {
        selectedFile: null,
        content: "",
        committedContent: "",
        lastDiskContent: "",
        loadingFile: false,
        saving: false,
        autoSaveState: "idle",
        textViewMode: "edit",
        _fileLoadRequestId: 0,
        _autoSaveRequestId: 0,
        _autoSaveAbortController: null,
        _autoSaveTimeoutId: null,
        _nextSaveSequence: 0,
        _saveBaselineSequencesByPath: new Map(),
        _selfOriginatedWatchWrites: new Map(),
        _manualSaveInFlight: null,
        _autoSaveCanRecover: false,
        _suppressNextBeforeUnload: false,

        setContent(next) {
          set((state) => ({ file: { ...state.file, content: next } }));
        },

        setTextViewMode(mode) {
          set((state) => ({ file: { ...state.file, textViewMode: mode } }));
        },

        toggleTextViewMode() {
          set((state) => ({
            file: {
              ...state.file,
              textViewMode: state.file.textViewMode === "edit" ? "preview" : "edit",
            },
          }));
        },

        setSuppressNextBeforeUnload(value) {
          get().file._suppressNextBeforeUnload = value;
        },

        hasUnsavedEdits() {
          const file = get().file;
          if (!file.selectedFile?.editable) return false;
          return file.content !== file.lastDiskContent;
        },

        resolveAutoSavePolicy(file) {
          const policy = config.autoSave?.(file);
          if (!policy) return null;
          return {
            commit: policy.commit ?? false,
            delayMs: policy.delayMs ?? DEFAULT_AUTOSAVE_DELAY_MS,
          };
        },

        rememberSelfOriginatedWatchWrite(path) {
          const now = Date.now();
          get().file._selfOriginatedWatchWrites.set(path, {
            expiresAt: now + SELF_ORIGINATED_WATCH_SUPPRESSION_MS,
            remainingEvents: 3,
            startedAt: now - 1000,
          });
        },

        isSelfOriginatedWatchEvent(event: FileBrowserWatchEvent) {
          const map = get().file._selfOriginatedWatchWrites;
          const suppression = map.get(event.path);
          if (!suppression) return false;
          if (Date.now() > suppression.expiresAt || event.at < suppression.startedAt) {
            map.delete(event.path);
            return false;
          }
          suppression.remainingEvents -= 1;
          if (suppression.remainingEvents <= 0) {
            map.delete(event.path);
          }
          return true;
        },

        async writeFileContent({ commit, contentToSave, path, signal }) {
          const fileSlice = get().file;
          const saveSequence = ++fileSlice._nextSaveSequence;
          fileSlice.rememberSelfOriginatedWatchWrite(path);
          try {
            const response = await fetch(`${apiBasePath}/file`, {
              body: JSON.stringify({ commit, content: contentToSave, path }),
              headers: { "Content-Type": "application/json" },
              method: "PUT",
              signal,
            });
            const data = (await response.json()) as { error?: string; message?: string };
            if (response.ok) {
              const baselineUpdate = getSuccessfulFileSaveBaselineUpdate({
                commit,
                savedPath: path,
                selectedPath: get().selection.selectedPath,
                sequence: saveSequence,
                sequences: fileSlice._saveBaselineSequencesByPath.get(path) ?? {
                  commit: 0,
                  disk: 0,
                },
              });
              fileSlice._saveBaselineSequencesByPath.set(path, baselineUpdate.sequences);
              if (baselineUpdate.applyDisk) {
                set((s) => ({ file: { ...s.file, lastDiskContent: contentToSave } }));
              }
              if (baselineUpdate.applyCommit) {
                set((s) => ({ file: { ...s.file, committedContent: contentToSave } }));
              }
              return { message: data.message, success: true };
            }
            return { error: data.error || config.t("status.saveFailed"), success: false };
          } catch (error) {
            if ((error as { name?: string }).name === "AbortError") {
              return { aborted: true, success: false };
            }
            return { error: config.t("status.networkError"), success: false };
          }
        },

        async loadFile(path, opts) {
          const fileSlice = get().file;
          const selectionSlice = get().selection;
          const requestId = ++fileSlice._fileLoadRequestId;
          const preserveDisplayedContent =
            opts?.preserveDisplayedContent &&
            shouldPreserveDisplayedFileContent({
              currentPath: selectionSlice.selectedPath,
              displayedFilePath: fileSlice.selectedFile?.path ?? null,
              requestedPath: path,
            });

          if (!opts?.preserveTreeSelection) {
            selectionSlice._anchorPath = path;
            set((s) => ({ selection: { ...s.selection, selectedTreePaths: [path] } }));
          }
          if (opts?.syncUrl !== false) {
            selectionSlice.navigateToPath(path);
          }
          set((s) => ({
            selection: { ...s.selection, selectedPath: path, selectedFolderPath: null },
          }));
          if (!preserveDisplayedContent) {
            set((s) => ({
              file: {
                ...s.file,
                selectedFile: null,
                content: "",
                committedContent: "",
                lastDiskContent: "",
                loadingFile: true,
                autoSaveState: "idle",
              },
              ui: { ...s.ui, showHistory: false, showSearch: false },
            }));
          }

          try {
            const response = await fetch(`${apiBasePath}/file?path=${encodeURIComponent(path)}`);
            if (
              get().file._fileLoadRequestId !== requestId ||
              get().selection.selectedPath !== path
            ) {
              return "failed";
            }
            if (!response.ok) {
              return response.status === 404 ? "missing" : "failed";
            }

            const data = (await response.json()) as BrowserFile;
            if (
              get().file._fileLoadRequestId !== requestId ||
              get().selection.selectedPath !== path
            ) {
              return "failed";
            }

            const nextContent = data.content ?? "";
            if (preserveDisplayedContent && get().file.hasUnsavedEdits()) {
              return "loaded";
            }
            set((s) => ({
              file: {
                ...s.file,
                selectedFile: data,
                content: nextContent,
                committedContent: nextContent,
                lastDiskContent: nextContent,
                textViewMode:
                  data.kind === "text" && getTextPreviewKind(data.path, data.mimeType)
                    ? "preview"
                    : "edit",
              },
            }));
            return "loaded";
          } catch (error) {
            console.error("Failed to load file:", error);
          } finally {
            if (get().file._fileLoadRequestId === requestId && !preserveDisplayedContent) {
              set((s) => ({ file: { ...s.file, loadingFile: false } }));
            }
          }
          return "failed";
        },

        clearFile() {
          set((s) => ({
            file: {
              ...s.file,
              selectedFile: null,
              content: "",
              committedContent: "",
              lastDiskContent: "",
              autoSaveState: "idle",
            },
          }));
        },

        async flushAutoSave(): Promise<boolean> {
          const fileSlice = get().file;
          if (fileSlice._manualSaveInFlight) return false;
          const file = fileSlice.selectedFile;
          const path = get().selection.selectedPath;
          const contentToSave = fileSlice.content;
          if (!file || !path || !file.editable || contentToSave === fileSlice.lastDiskContent) {
            return false;
          }
          const policy = fileSlice.resolveAutoSavePolicy(file);
          if (!policy) return false;

          if (fileSlice._autoSaveTimeoutId !== null) {
            window.clearTimeout(fileSlice._autoSaveTimeoutId);
            fileSlice._autoSaveTimeoutId = null;
          }
          fileSlice._autoSaveAbortController?.abort();
          fileSlice._autoSaveAbortController = null;
          fileSlice._autoSaveRequestId += 1;
          set((s) => ({ file: { ...s.file, autoSaveState: "saving" } }));
          const result = await fileSlice.writeFileContent({
            commit: policy.commit ?? false,
            contentToSave,
            path,
          });
          if (get().selection.selectedPath !== path) {
            return result.success;
          }
          if (result.success) {
            set((s) => ({ file: { ...s.file, autoSaveState: "saved" } }));
            return true;
          }
          if (!result.aborted) {
            set((s) => ({ file: { ...s.file, autoSaveState: "error" } }));
          }
          return false;
        },

        async saveFile() {
          const fileSlice = get().file;
          const selectedPath = get().selection.selectedPath;
          if (!selectedPath || !fileSlice.selectedFile?.editable) return;
          set((s) => ({ file: { ...s.file, saving: true } }));
          const savePromise = (async () => {
            const result = await fileSlice.writeFileContent({
              commit: true,
              contentToSave: fileSlice.content,
              path: selectedPath,
            });
            if (result.success) {
              set((s) => ({ file: { ...s.file, autoSaveState: "idle" } }));
              toast.success(result.message || config.t("status.saved"));
            } else if (!result.aborted) {
              toast.error(result.error || config.t("status.saveFailed"));
            }
          })();
          fileSlice._manualSaveInFlight = savePromise.then(
            () => undefined,
            () => undefined,
          );
          try {
            await savePromise;
          } finally {
            fileSlice._manualSaveInFlight = null;
            set((s) => ({ file: { ...s.file, saving: false } }));
          }
        },

        async resolveUnsavedEditsBeforeLeaving() {
          const fileSlice = get().file;
          if (fileSlice._manualSaveInFlight) {
            await fileSlice._manualSaveInFlight;
          }
          if (!get().file.hasUnsavedEdits()) return true;

          const file = get().file.selectedFile;
          if (
            file &&
            get().file.resolveAutoSavePolicy(file) &&
            get().file.content !== get().file.lastDiskContent
          ) {
            const saved = await get().file.flushAutoSave();
            if (!saved && get().file.content !== get().file.lastDiskContent) {
              toast.error(config.t("status.saveFailed"));
            }
          }

          if (get().file.content === get().file.lastDiskContent) return true;

          const discarded = await new Promise<boolean>((resolve) => {
            get().refs.discardChangesResolver?.(false);
            get().refs.discardChangesResolver = resolve;
            set((s) => ({ ui: { ...s.ui, discardChangesConfirmOpen: true } }));
          });
          if (discarded) {
            const savedContent = get().file.lastDiskContent;
            set((s) => ({ file: { ...s.file, content: savedContent } }));
          }
          return discarded;
        },
      },

      ui: {
        history: [],
        loadingHistory: false,
        showHistory: false,
        searchQuery: "",
        searchResults: [],
        searching: false,
        showSearch: false,
        nameDialog: null,
        deleteConfirm: null,
        moveDialog: null,
        discardChangesConfirmOpen: false,
        isDragActive: false,
        sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
        isResizingSidebar: false,
        creating: false,
        deleting: false,
        moving: false,
        renaming: false,
        uploading: false,
        filesPaneDrillPath: null,

        setSearchQuery(value) {
          set((s) => ({ ui: { ...s.ui, searchQuery: value } }));
        },
        setShowSearch(value) {
          set((s) => ({ ui: { ...s.ui, showSearch: value } }));
        },
        setShowHistory(value) {
          set((s) => ({ ui: { ...s.ui, showHistory: value } }));
        },
        setNameDialog(value) {
          set((s) => ({ ui: { ...s.ui, nameDialog: value } }));
        },
        setDeleteConfirm(value) {
          set((s) => ({ ui: { ...s.ui, deleteConfirm: value } }));
        },
        setMoveDialog(value) {
          set((s) => ({ ui: { ...s.ui, moveDialog: value } }));
        },
        resolveDiscardChangesConfirm(discard) {
          const resolve = get().refs.discardChangesResolver;
          get().refs.discardChangesResolver = null;
          set((s) => ({ ui: { ...s.ui, discardChangesConfirmOpen: false } }));
          resolve?.(discard);
        },
        setIsDragActive(value) {
          set((s) => ({ ui: { ...s.ui, isDragActive: value } }));
        },
        setSidebarWidth(value) {
          set((s) => ({ ui: { ...s.ui, sidebarWidth: value } }));
        },
        setIsResizingSidebar(value) {
          set((s) => ({ ui: { ...s.ui, isResizingSidebar: value } }));
        },
        setFilesPaneDrillPath(value) {
          set((s) => ({ ui: { ...s.ui, filesPaneDrillPath: value } }));
        },

        async loadHistory() {
          const selectedPath = get().selection.selectedPath;
          if (!selectedPath) return;
          set((s) => ({ ui: { ...s.ui, showHistory: true, loadingHistory: true } }));
          try {
            const response = await fetch(
              `${apiBasePath}/history?path=${encodeURIComponent(selectedPath)}`,
            );
            const data = await response.json();
            set((s) => ({ ui: { ...s.ui, history: Array.isArray(data) ? data : [] } }));
          } catch {
            set((s) => ({ ui: { ...s.ui, history: [] } }));
          } finally {
            set((s) => ({ ui: { ...s.ui, loadingHistory: false } }));
          }
        },

        async doSearch() {
          const query = get().ui.searchQuery;
          if (!query.trim()) return;
          set((s) => ({ ui: { ...s.ui, searching: true, showSearch: true } }));
          try {
            const response = await fetch(`${apiBasePath}/search?q=${encodeURIComponent(query)}`);
            const data = await response.json();
            set((s) => ({ ui: { ...s.ui, searchResults: Array.isArray(data) ? data : [] } }));
          } catch {
            set((s) => ({ ui: { ...s.ui, searchResults: [] } }));
          } finally {
            set((s) => ({ ui: { ...s.ui, searching: false } }));
          }
        },

        triggerUploadForFolder(path) {
          get().refs.pendingUploadTarget = path;
          get().refs.fileInput?.click();
        },

        triggerFolderUploadForFolder(path) {
          get().refs.pendingUploadTarget = path;
          get().refs.folderInput?.click();
        },

        async uploadFiles(files, targetPathOverride) {
          if (files.length === 0) return;
          const state = get();
          const fallbackTarget =
            state.selection.selectedFolderPath ??
            state.ui.filesPaneDrillPath ??
            getParentPath(state.selection.selectedPath, logicalRootPath);
          const target = targetPathOverride ?? fallbackTarget;
          if (
            state.file.hasUnsavedEdits() &&
            !(await state.file.resolveUnsavedEditsBeforeLeaving())
          ) {
            return;
          }

          set((s) => ({ ui: { ...s.ui, uploading: true } }));
          try {
            const formData = new FormData();
            formData.append("path", target);
            for (const { file, relativePath } of files) {
              formData.append("files", file);
              formData.append("paths", relativePath);
            }
            const response = await fetch(`${apiBasePath}/file`, { body: formData, method: "POST" });
            const data = (await response.json()) as UploadResponse;
            if (!response.ok) {
              toast.error(data.error || config.t("status.uploadFailed"));
              return;
            }
            const firstUploadedPath = data.files?.[0]?.path;
            if (firstUploadedPath) {
              await get().tree.loadDirectoryAncestors(firstUploadedPath);
              await get().file.loadFile(firstUploadedPath, {});
            } else {
              await get().tree.loadRoot();
            }
            toast.success(
              data.message || config.t("status.uploadedFiles", { count: files.length }),
            );
          } catch {
            toast.error(config.t("status.networkError"));
          } finally {
            set((s) => ({ ui: { ...s.ui, uploading: false } }));
          }
        },

        createPath(type, parentPath) {
          const state = get();
          const fallbackTarget =
            state.selection.selectedFolderPath ??
            state.ui.filesPaneDrillPath ??
            getParentPath(state.selection.selectedPath, logicalRootPath);
          const resolvedParent = parentPath ?? fallbackTarget;
          const target =
            resolvedParent === logicalRootPath ? config.rootLabel : `${resolvedParent}/`;
          set((s) => ({
            ui: {
              ...s.ui,
              nameDialog: {
                confirmLabel:
                  type === "file"
                    ? config.t("dialog.createFileConfirm")
                    : config.t("dialog.createFolderConfirm"),
                description:
                  type === "file"
                    ? config.t("dialog.createFileDescription", { target })
                    : config.t("dialog.createFolderDescription", { target }),
                initialValue:
                  type === "file"
                    ? config.t("dialog.defaultFileName")
                    : config.t("dialog.defaultFolderName"),
                inputLabel: config.t("dialog.nameLabel"),
                mode: "create",
                parentPath: resolvedParent,
                title:
                  type === "file"
                    ? config.t("dialog.createFileTitle")
                    : config.t("dialog.createFolderTitle"),
                type,
              },
            },
          }));
        },

        async createPathWithName(type, parentPath, name) {
          if (!name) return;
          const state = get();
          if (
            state.file.hasUnsavedEdits() &&
            !(await state.file.resolveUnsavedEditsBeforeLeaving())
          ) {
            return;
          }

          const failureMessage =
            type === "file"
              ? config.t("status.createFileFailed")
              : config.t("status.createFolderFailed");
          const successMessage =
            type === "file" ? config.t("status.createdFile") : config.t("status.createdFolder");

          set((s) => ({ ui: { ...s.ui, creating: true } }));
          try {
            const response = await fetch(`${apiBasePath}/file`, {
              body: JSON.stringify({ path: getChildPath(parentPath, name), type }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            });
            const data = (await response.json()) as CreateResponse;
            if (!response.ok || !data.path) {
              toast.error(data.error || failureMessage);
              return;
            }
            if (type === "file") {
              await get().tree.loadDirectoryAncestors(data.path);
              await get().file.loadFile(data.path, {});
            } else {
              await get().tree.loadDirectoryAncestors(data.path);
              await get().tree.loadPath(data.path);
              get().selection.selectFolder(data.path, { expand: true });
              config.onFolderCreated?.(data.path, parentPath);
            }
            set((s) => ({ ui: { ...s.ui, showSearch: false } }));
            toast.success(data.message || successMessage);
          } catch {
            toast.error(config.t("status.networkError"));
          } finally {
            set((s) => ({ ui: { ...s.ui, creating: false } }));
          }
        },

        renamePath(path) {
          if (path === logicalRootPath) {
            toast.error(config.t("status.cannotRenameRoot", { rootLabel: config.rootLabel }));
            return;
          }
          const state = get();
          const openDialog = () => {
            const currentName = getBaseName(path);
            set((s) => ({
              ui: {
                ...s.ui,
                nameDialog: {
                  confirmLabel: config.t("dialog.renameConfirm"),
                  currentName,
                  description: config.t("dialog.renameDescription", { path }),
                  initialValue: currentName,
                  inputLabel: config.t("dialog.nameLabel"),
                  mode: "rename",
                  path,
                  title: config.t("dialog.renameTitle"),
                },
              },
            }));
          };
          if (state.file.hasUnsavedEdits() && isPathWithin(state.selection.selectedPath, path)) {
            void state.file.resolveUnsavedEditsBeforeLeaving().then((canLeave) => {
              if (canLeave) openDialog();
            });
            return;
          }
          openDialog();
        },

        async renamePathWithName(path, currentName, nextName) {
          if (!nextName || nextName === currentName) return;
          set((s) => ({ ui: { ...s.ui, renaming: true } }));
          try {
            const response = await fetch(`${apiBasePath}/file`, {
              body: JSON.stringify({ name: nextName, path }),
              headers: { "Content-Type": "application/json" },
              method: "PATCH",
            });
            const data = (await response.json()) as {
              error?: string;
              message?: string;
              path?: string;
            };
            if (!response.ok || !data.path) {
              toast.error(data.error || config.t("status.renameFailed"));
              return;
            }
            await reloadAfterPathChange(path, data.path);
            toast.success(data.message || config.t("status.renamed"));
          } catch {
            toast.error(config.t("status.networkError"));
          } finally {
            set((s) => ({ ui: { ...s.ui, renaming: false } }));
          }
        },

        requestDeletePaths(paths) {
          const actionPaths = getTopLevelActionPaths(paths);
          if (actionPaths.length === 0) return;
          if (actionPaths.includes(logicalRootPath)) {
            toast.error(config.t("status.cannotDeleteRoot", { rootLabel: config.rootLabel }));
            return;
          }
          const defaultDescription =
            actionPaths.length === 1
              ? config.t("dialog.deleteDescription", { name: getBaseName(actionPaths[0]) })
              : config.t("dialog.deleteDescriptionMany", { count: actionPaths.length });
          const entries = actionPaths.map((path) => ({
            path,
            type: findTreeNode(get().tree.nodes, path)?.type ?? null,
          }));
          const description =
            config.getDeleteDescription?.({ paths: actionPaths, entries, defaultDescription }) ??
            defaultDescription;
          const title =
            actionPaths.length === 1
              ? config.t("dialog.deleteTitle")
              : config.t("dialog.deleteTitleMany");
          set((s) => ({
            ui: { ...s.ui, deleteConfirm: { paths: actionPaths, title, description } },
          }));
        },

        async deletePaths(paths) {
          const actionPaths = getTopLevelActionPaths(paths);
          if (actionPaths.length === 0) return;
          if (actionPaths.includes(logicalRootPath)) {
            toast.error(config.t("status.cannotDeleteRoot", { rootLabel: config.rootLabel }));
            return;
          }
          const selectedPath = get().selection.selectedPath;
          const deletesSelectedFile = actionPaths.some((p) => isPathWithin(selectedPath, p));
          if (deletesSelectedFile && !(await get().file.resolveUnsavedEditsBeforeLeaving())) {
            return;
          }

          set((s) => ({ ui: { ...s.ui, deleting: true } }));
          try {
            let message: string | null = null;
            for (const path of actionPaths) {
              const response = await fetch(`${apiBasePath}/file?path=${encodeURIComponent(path)}`, {
                method: "DELETE",
              });
              const data = await response.json();
              if (!response.ok) {
                toast.error(data.error || config.t("status.deleteFailed"));
                return;
              }
              message = data.message ?? null;
            }

            const selection = get().selection;
            const deletedSelectedPath = actionPaths.some((p) =>
              isPathWithin(selection.selectedPath, p),
            );
            const deletedSelectedFolderPath = actionPaths.some((p) =>
              isPathWithin(selection.selectedFolderPath, p),
            );
            if (deletedSelectedPath) {
              set((s) => ({
                selection: { ...s.selection, selectedPath: null },
                file: {
                  ...s.file,
                  selectedFile: null,
                  content: "",
                  committedContent: "",
                  lastDiskContent: "",
                },
                ui: { ...s.ui, history: [], showHistory: false },
              }));
            }
            if (deletedSelectedFolderPath) {
              set((s) => ({ selection: { ...s.selection, selectedFolderPath: null } }));
            }
            if (deletedSelectedPath || deletedSelectedFolderPath) {
              get().selection.navigateToPath(null, { replace: true });
            }
            set((s) => ({
              selection: {
                ...s.selection,
                selectedTreePaths: s.selection.selectedTreePaths.filter(
                  (treePath) => !actionPaths.some((p) => isPathWithin(treePath, p)),
                ),
              },
            }));
            if (
              get().selection._anchorPath &&
              actionPaths.some((p) => isPathWithin(get().selection._anchorPath, p))
            ) {
              get().selection._anchorPath = null;
            }
            set((s) => ({ ui: { ...s.ui, showSearch: false } }));
            await get().tree.loadRoot();
            try {
              config.onPathsDeleted?.(actionPaths);
            } catch {
              // Host notifications must not turn a completed delete into a failed one.
            }
            toast.success(
              actionPaths.length === 1
                ? message || config.t("status.deleted")
                : config.t("status.deletedItems", { count: actionPaths.length }),
            );
          } catch {
            toast.error(config.t("status.networkError"));
          } finally {
            set((s) => ({ ui: { ...s.ui, deleting: false } }));
          }
        },

        downloadPaths(paths) {
          const actionPaths = getTopLevelActionPaths(paths);
          if (actionPaths.length === 0) return;
          const params = new URLSearchParams();
          for (const path of actionPaths) {
            params.append("path", path);
          }
          window.location.assign(`${apiBasePath}/download?${params.toString()}`);
        },

        /**
         * Opens the destination picker. Deliberately does not resolve unsaved
         * edits here: `movePathToFolder` runs that guard immediately before the
         * PATCH, so merely opening (and then cancelling) the picker can never
         * discard the editor buffer.
         */
        requestMovePath(path) {
          if (path === logicalRootPath) {
            toast.error(config.t("status.cannotMoveRoot", { rootLabel: config.rootLabel }));
            return;
          }
          set((s) => ({
            ui: {
              ...s.ui,
              moveDialog: { currentPath: getParentPath(path, logicalRootPath), path },
            },
          }));
        },

        async movePathToFolder(path, parentPath) {
          if (path === logicalRootPath) {
            toast.error(config.t("status.cannotMoveRoot", { rootLabel: config.rootLabel }));
            return false;
          }
          if (isPathWithin(parentPath, path)) {
            toast.error(config.t("status.cannotMoveIntoSelf"));
            return false;
          }
          const state = get();
          if (
            state.file.hasUnsavedEdits() &&
            isPathWithin(state.selection.selectedPath, path) &&
            !(await state.file.resolveUnsavedEditsBeforeLeaving())
          ) {
            return false;
          }
          set((s) => ({ ui: { ...s.ui, moving: true } }));
          try {
            const response = await fetch(`${apiBasePath}/file`, {
              body: JSON.stringify({ parentPath, path }),
              headers: { "Content-Type": "application/json" },
              method: "PATCH",
            });
            const data = (await response.json()) as MoveResponse;
            if (!response.ok || !data.path) {
              toast.error(data.error || config.t("status.moveFailed"));
              return false;
            }
            // Past this point the item HAS moved on disk. A failing refresh must
            // not be reported as a failed move, or a dialog caller would stay
            // open on a source path that no longer exists and retry into a 404.
            try {
              await reloadAfterPathChange(path, data.path);
              toast.success(data.message || config.t("status.moved"));
            } catch {
              toast.success(config.t("status.movedRefreshFailed"));
            }
            return true;
          } catch {
            toast.error(config.t("status.networkError"));
            return false;
          } finally {
            set((s) => ({ ui: { ...s.ui, moving: false } }));
          }
        },

        async copyPath(text) {
          try {
            if (navigator.clipboard?.writeText) {
              await navigator.clipboard.writeText(text);
            } else {
              const textarea = document.createElement("textarea");
              textarea.value = text;
              textarea.style.position = "fixed";
              textarea.style.opacity = "0";
              document.body.appendChild(textarea);
              textarea.select();
              const copied = document.execCommand("copy");
              document.body.removeChild(textarea);
              if (!copied) throw new Error("execCommand copy failed");
            }
            toast.success(config.t("status.copied"));
          } catch {
            toast.error(config.t("status.copyFailed"));
          }
        },

        async handleNameDialogConfirm(rawName) {
          const dialog = get().ui.nameDialog;
          if (!dialog) return;
          const name = rawName.trim();
          if (!name) {
            set((s) => ({
              ui: {
                ...s.ui,
                nameDialog: { ...dialog, error: config.t("dialog.errorNameRequired") },
              },
            }));
            return;
          }
          if (!isValidNewItemName(name)) {
            set((s) => ({
              ui: {
                ...s.ui,
                nameDialog: { ...dialog, error: config.t("dialog.errorNameInvalid") },
              },
            }));
            return;
          }
          set((s) => ({ ui: { ...s.ui, nameDialog: null } }));
          if (dialog.mode === "create") {
            await get().ui.createPathWithName(dialog.type, dialog.parentPath, name);
            return;
          }
          await get().ui.renamePathWithName(dialog.path, dialog.currentName, name);
        },

        _openRenameDialog(path: string) {
          const currentName = getBaseName(path);
          set((s) => ({
            ui: {
              ...s.ui,
              nameDialog: {
                confirmLabel: config.t("dialog.renameConfirm"),
                currentName,
                description: config.t("dialog.renameDescription", { path }),
                initialValue: currentName,
                inputLabel: config.t("dialog.nameLabel"),
                mode: "rename",
                path,
                title: config.t("dialog.renameTitle"),
              },
            },
          }));
        },
      },

      watch: {
        clearDeletedSelection(deletedPath) {
          const state = get();
          const currentSelectedPath = state.selection.selectedPath;
          const currentSelectedFolderPath = state.selection.selectedFolderPath;
          const deletedSelectedFile = isPathWithin(currentSelectedPath, deletedPath);
          const deletedSelectedFolder = isPathWithin(currentSelectedFolderPath, deletedPath);
          const preserveDirtySelectedFile = deletedSelectedFile && state.file.hasUnsavedEdits();

          if (deletedSelectedFile && !preserveDirtySelectedFile) {
            set((s) => ({
              selection: { ...s.selection, selectedPath: null },
              file: {
                ...s.file,
                selectedFile: null,
                content: "",
                committedContent: "",
                lastDiskContent: "",
              },
              ui: { ...s.ui, history: [], showHistory: false },
            }));
          }
          if (preserveDirtySelectedFile) {
            toast.error(config.t("status.externalDeleteKeptBuffer"));
          }
          if (deletedSelectedFolder) {
            set((s) => ({ selection: { ...s.selection, selectedFolderPath: null } }));
          }
          if (isPathWithin(state.ui.filesPaneDrillPath, deletedPath)) {
            set((s) => ({ ui: { ...s.ui, filesPaneDrillPath: logicalRootPath } }));
          }
          if ((deletedSelectedFile && !preserveDirtySelectedFile) || deletedSelectedFolder) {
            state.selection.navigateToPath(null, { replace: true });
          }
          set((s) => ({
            selection: {
              ...s.selection,
              selectedTreePaths: s.selection.selectedTreePaths.filter(
                (p) => !isPathWithin(p, deletedPath),
              ),
            },
          }));
          if (
            state.selection._anchorPath &&
            isPathWithin(state.selection._anchorPath, deletedPath)
          ) {
            state.selection._anchorPath = null;
          }
          set((s) => {
            const next = new Set(s.tree.expandedPaths);
            for (const p of s.tree.expandedPaths) {
              if (isPathWithin(p, deletedPath)) next.delete(p);
            }
            return { tree: { ...s.tree, expandedPaths: next } };
          });
        },
      },
    };
  });

  return store;
}
