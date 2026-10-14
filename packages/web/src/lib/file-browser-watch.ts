import {
  type FileWatchParams,
  type FileWatchScope,
  fileWatchParamsSchema,
  fileWatchTopicName,
  MAX_SUBSCRIBE_PARAMS_BYTES,
} from "@rome/api-types/live-events";

export interface FileBrowserWatchEvent {
  at: number;
  kind: "add" | "addDir" | "change" | "unlink" | "unlinkDir";
  logicalRoot: string;
  path: string;
}

export interface FileBrowserWatchTreeNode {
  children?: FileBrowserWatchTreeNode[];
  path: string;
  type?: "directory" | "file";
}

type DeletedWatchEventKind = "unlink" | "unlinkDir";
type AddedWatchEventKind = "add" | "addDir";

export type FileBrowserWatchPathExists = (
  path: string,
  kind: DeletedWatchEventKind,
) => Promise<boolean>;

interface GetAbsentDeletedWatchPathsOptions {
  refreshedTree?: FileBrowserWatchTreeNode[];
}

interface GetFileBrowserWatchPathsOptions {
  selectedFilePath?: string | null;
  selectedFolderPath?: string | null;
  /**
   * The folder the sm-only FilesPane navigator is currently drilled into.
   * Watched so external add/delete events in the visible folder refresh the
   * navigator the same way they do for the desktop tree.
   */
  filesPaneDrillPath?: string | null;
}

function isPathWithin(path: string | null | undefined, parentPath: string): path is string {
  return Boolean(path && (path === parentPath || path.startsWith(`${parentPath}/`)));
}

function getParentPath(path: string | null | undefined, logicalRootPath: string): string {
  if (!path || !isPathWithin(path, logicalRootPath)) {
    return logicalRootPath;
  }

  const lastSlashIndex = path.lastIndexOf("/");
  if (lastSlashIndex <= logicalRootPath.length) {
    return logicalRootPath;
  }

  return path.slice(0, lastSlashIndex);
}

export function getFileBrowserWatchPaths(
  logicalRootPath: string,
  expandedPaths: Iterable<string>,
  options: GetFileBrowserWatchPathsOptions = {},
): string[] {
  const watchedPaths = new Set([logicalRootPath]);
  for (const path of expandedPaths) {
    if (isPathWithin(path, logicalRootPath)) {
      watchedPaths.add(path);
    }
  }

  if (isPathWithin(options.selectedFolderPath, logicalRootPath)) {
    watchedPaths.add(options.selectedFolderPath);
  }
  if (isPathWithin(options.filesPaneDrillPath, logicalRootPath)) {
    watchedPaths.add(options.filesPaneDrillPath);
  }
  watchedPaths.add(getParentPath(options.selectedFilePath, logicalRootPath));

  return Array.from(watchedPaths).sort((left, right) => left.localeCompare(right));
}

export function createFileBrowserEventsUrl(apiBasePath: string, watchPaths: string[]): string {
  const params = new URLSearchParams();
  for (const path of watchPaths) {
    params.append("watch", path);
  }

  const query = params.toString();
  return query ? `${apiBasePath}/events?${query}` : `${apiBasePath}/events`;
}

// The dashboard's own file APIs. The share page's token-scoped API has no
// watch route, so it stays off the socket.
const FILE_WATCH_SCOPES_BY_API_BASE_PATH: Readonly<Record<string, FileWatchScope>> = {
  "/api/projects": "projects",
  "/api/memory": "memory",
};

/**
 * The live-events topic for a watch, named after its path set, or null when
 * the watch stays on its SSE route: the API has no topic, or the set is too
 * large for a subscribe frame.
 */
export function getFileBrowserWatchTopic(
  apiBasePath: string,
  watchPaths: string[],
): { topic: string; params: FileWatchParams } | null {
  const scope = Object.hasOwn(FILE_WATCH_SCOPES_BY_API_BASE_PATH, apiBasePath)
    ? FILE_WATCH_SCOPES_BY_API_BASE_PATH[apiBasePath]
    : null;
  if (!scope) return null;
  const params: FileWatchParams = { watch: watchPaths };
  if (!fileWatchParamsSchema.safeParse(params).success) return null;
  const encoded = JSON.stringify(params);
  if (new TextEncoder().encode(encoded).length > MAX_SUBSCRIBE_PARAMS_BYTES) return null;
  return { topic: fileWatchTopicName(scope, hashKey(encoded)), params };
}

// cyrb53: a 53-bit string hash. Two path sets in one tab share a topic only
// on a collision, which this width makes negligible.
function hashKey(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function isSamePathReplacement(
  deletedKind: DeletedWatchEventKind,
  addedKind: AddedWatchEventKind,
): boolean {
  return (
    (deletedKind === "unlink" && addedKind === "add") ||
    (deletedKind === "unlinkDir" && addedKind === "addDir")
  );
}

function getDeletedPathNodeType(kind: DeletedWatchEventKind): "directory" | "file" {
  return kind === "unlinkDir" ? "directory" : "file";
}

export function findFileBrowserTreeNode(
  nodes: FileBrowserWatchTreeNode[],
  path: string,
): FileBrowserWatchTreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;

    const childNode = findFileBrowserTreeNode(node.children ?? [], path);
    if (childNode) return childNode;
  }

  return null;
}

export async function getAbsentDeletedWatchPaths(
  events: FileBrowserWatchEvent[],
  pathExists: FileBrowserWatchPathExists,
  options: GetAbsentDeletedWatchPathsOptions = {},
): Promise<string[]> {
  const deletedPaths = new Map<string, DeletedWatchEventKind>();
  for (const event of events) {
    if (event.kind === "unlink" || event.kind === "unlinkDir") {
      deletedPaths.set(event.path, event.kind);
    } else if (event.kind === "add" || event.kind === "addDir") {
      const deletedKind = deletedPaths.get(event.path);
      if (deletedKind && isSamePathReplacement(deletedKind, event.kind)) {
        deletedPaths.delete(event.path);
      }
    }
  }

  const collapsedDeletedPaths: Array<[string, DeletedWatchEventKind]> = [];
  for (const [deletedPath, kind] of Array.from(deletedPaths).sort(([left], [right]) => {
    const depthDelta = left.split("/").length - right.split("/").length;
    return depthDelta === 0 ? left.localeCompare(right) : depthDelta;
  })) {
    const coveredByDeletedDirectory = collapsedDeletedPaths.some(
      ([existingPath, existingKind]) =>
        existingKind === "unlinkDir" && isPathWithin(deletedPath, existingPath),
    );
    if (!coveredByDeletedDirectory) {
      collapsedDeletedPaths.push([deletedPath, kind]);
    }
  }

  const existenceResults = await Promise.all(
    collapsedDeletedPaths.map(async ([deletedPath, kind]) => {
      const refreshedNode = options.refreshedTree
        ? findFileBrowserTreeNode(options.refreshedTree, deletedPath)
        : null;
      if (
        refreshedNode &&
        (!refreshedNode.type || refreshedNode.type === getDeletedPathNodeType(kind))
      ) {
        return null;
      }
      return (await pathExists(deletedPath, kind)) ? null : deletedPath;
    }),
  );
  return existenceResults.filter((path): path is string => path !== null);
}

export function shouldReloadSelectedWatchFile(
  events: FileBrowserWatchEvent[],
  selectedPath: string | null,
  isSelfOriginated?: (event: FileBrowserWatchEvent) => boolean,
): boolean {
  if (!selectedPath) return false;

  return events.some((event) => {
    if (event.path !== selectedPath || (event.kind !== "add" && event.kind !== "change")) {
      return false;
    }
    return !isSelfOriginated?.(event);
  });
}
