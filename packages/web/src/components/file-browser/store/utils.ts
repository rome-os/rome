import type { TreeNode } from "./types";

export const TREE_NODE_DRAG_MIME = "application/x-rome-file-browser-node";
export const DEFAULT_AUTOSAVE_DELAY_MS = 2000;
export const INITIAL_TREE_DEPTH = 2;
export const FOLDER_TREE_DEPTH = 1;
export const SELF_ORIGINATED_WATCH_SUPPRESSION_MS = 5000;
export const DEFAULT_SIDEBAR_WIDTH = 288;
export const MIN_SIDEBAR_WIDTH = 224;
export const MAX_SIDEBAR_WIDTH = 676;
export const DESKTOP_MIN_WIDTH = 768;
export const DESKTOP_MEDIA_QUERY = `(min-width: ${DESKTOP_MIN_WIDTH}px)`;
// Min width the file browser needs to keep its two-pane layout. Below this the
// Shell collapses to the single-pane (FilesPane) navigator. Measured against the
// browser's *own* width (see `useContainerBelowWidth`), so an embedded panel
// collapses based on the panel's width, not the viewport — distinct from
// `DESKTOP_MIN_WIDTH`, which is the viewport phone/desktop breakpoint.
export const FILE_BROWSER_TWO_PANE_MIN_WIDTH = 1024;

export function getIsDesktopViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true;
  }
  return window.matchMedia(DESKTOP_MEDIA_QUERY).matches;
}

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

export function getParentPath(path: string | null, logicalRootPath: string): string {
  if (!path) return logicalRootPath;
  const lastSlashIndex = path.lastIndexOf("/");
  if (lastSlashIndex <= logicalRootPath.length) return logicalRootPath;
  return path.slice(0, lastSlashIndex);
}

export function getBaseName(path: string): string {
  const lastSlashIndex = path.lastIndexOf("/");
  return lastSlashIndex === -1 ? path : path.slice(lastSlashIndex + 1);
}

export function getChildPath(parentPath: string, name: string): string {
  return `${parentPath.replace(/\/+$/, "")}/${name}`;
}

export function isPathWithin(path: string | null, parentPath: string): boolean {
  return Boolean(path && (path === parentPath || path.startsWith(`${parentPath}/`)));
}

export function isValidNewItemName(name: string): boolean {
  return Boolean(
    name && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\"),
  );
}

export function findDirectoryTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) {
      return node.type === "directory" ? node : null;
    }
    if (node.children) {
      const childNode = findDirectoryTreeNode(node.children, path);
      if (childNode) return childNode;
    }
  }
  return null;
}

export function findTreeNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const childNode = findTreeNode(node.children, path);
      if (childNode) return childNode;
    }
  }
  return null;
}

export function getPathDepth(path: string): number {
  return path.split("/").length;
}

export function flattenVisibleTreePaths(nodes: TreeNode[], expandedPaths: Set<string>): string[] {
  return nodes.flatMap((node) => {
    if (node.type !== "directory" || !expandedPaths.has(node.path)) {
      return [node.path];
    }
    return [node.path, ...flattenVisibleTreePaths(node.children ?? [], expandedPaths)];
  });
}

/**
 * Drops duplicates and any path nested under another path in the list. The
 * survivors keep their input order, so a tree-ordered selection stays in tree
 * order.
 */
export function getTopLevelActionPaths(paths: string[]): string[] {
  const uniquePaths = Array.from(new Set(paths));
  return uniquePaths.filter(
    (path) =>
      !uniquePaths.some((parentPath) => parentPath !== path && isPathWithin(path, parentPath)),
  );
}
