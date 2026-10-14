import { Hono } from "hono";
import {
  createAssetHandler,
  createDownloadHandler,
  createFileDeleteHandler,
  createFileGetHandler,
  createFilePostHandler,
  createFilePutHandler,
  createFileRenameHandler,
  createFileWatchEventsHandler,
  createFileWatchHub,
  createHistoryHandler,
  createResolveHandler,
  createSearchHandler,
  createTreeHandler,
  type FileBrowserScope,
  type FileWatchHub,
} from "../../lib/file-browser-server.js";
import { ensureProfileMemoryInitialized } from "../../profile-memory.js";
import { withMemoryGitLock } from "../../sync/memory-git-lock.js";

/** The memory git repo lives at the memory dir, so commit paths are
 * relative to it — strip the `memory/` logical-root prefix. */
function toRepoPath(logicalPath: string): string {
  return logicalPath === "memory" ? "." : logicalPath.replace(/^memory\//, "");
}

/** The memory file routes, and the watch hub the live-events socket shares with them. */
export function createMemoryFiles(): { routes: Hono; fileWatch: FileWatchHub } {
  const app = new Hono();
  const rootDir = ensureProfileMemoryInitialized();

  const baseScope: FileBrowserScope = {
    assetBasePath: "/api/memory/asset",
    logicalRoot: "memory",
    rootDir,
  };

  const fileScope: FileBrowserScope = {
    ...baseScope,
    // Serialize every memory commit against the sync push/pull: both
    // write `memory/.git`, and interleaving trips git's index.lock.
    commitMutex: withMemoryGitLock,
    createCommitTarget: (_resolvedPath, logicalPath, type) => {
      const fileName = logicalPath.split("/").pop() || logicalPath;
      return {
        cwd: rootDir,
        gitPath: toRepoPath(logicalPath),
        message: `memory: create ${type === "folder" ? "folder " : ""}${fileName}`,
      };
    },
    historyTarget: (_resolvedPath, logicalPath) => ({
      cwd: rootDir,
      gitPath: toRepoPath(logicalPath),
    }),
    deleteCommitTarget: (_resolvedPath, logicalPath) => {
      const fileName = logicalPath.split("/").pop() || logicalPath;
      return {
        cwd: rootDir,
        gitPath: toRepoPath(logicalPath),
        message: `memory: delete ${fileName}`,
      };
    },
    saveCommitTarget: (_resolvedPath, logicalPath) => {
      const fileName = logicalPath.split("/").pop() || logicalPath;
      return {
        cwd: rootDir,
        gitPath: toRepoPath(logicalPath),
        message: `memory: update ${fileName}`,
      };
    },
    uploadCommitTarget: (files) => {
      const fileNames = files.map((file) => file.logicalPath.split("/").pop() || file.logicalPath);
      return {
        cwd: rootDir,
        gitPaths: files.map((file) => toRepoPath(file.logicalPath)),
        message:
          fileNames.length === 1
            ? `memory: upload ${fileNames[0]}`
            : `memory: upload ${fileNames.length} files`,
      };
    },
    renameCommitTarget: (_fromResolvedPath, _toResolvedPath, fromLogicalPath, toLogicalPath) => {
      const fromName = fromLogicalPath.split("/").pop() || fromLogicalPath;
      const toName = toLogicalPath.split("/").pop() || toLogicalPath;
      return {
        cwd: rootDir,
        gitPaths: [toRepoPath(fromLogicalPath), toRepoPath(toLogicalPath)],
        message: `memory: rename ${fromName} to ${toName}`,
      };
    },
  };

  const fileWatch = createFileWatchHub(baseScope);
  app.get("/memory/events", createFileWatchEventsHandler(fileWatch));
  app.get("/memory/tree", createTreeHandler(baseScope));
  app.get("/memory/resolve", createResolveHandler(baseScope));
  app.get("/memory/file", createFileGetHandler(fileScope));
  app.post("/memory/file", createFilePostHandler(fileScope));
  app.put("/memory/file", createFilePutHandler(fileScope));
  app.patch("/memory/file", createFileRenameHandler(fileScope));
  app.delete("/memory/file", createFileDeleteHandler(fileScope));
  app.get("/memory/asset", createAssetHandler(baseScope));
  app.get("/memory/asset/:fileName", createAssetHandler(baseScope));
  app.get("/memory/download", createDownloadHandler(baseScope));
  app.get("/memory/history", createHistoryHandler(fileScope));
  app.get("/memory/search", createSearchHandler({ ...baseScope, searchGlobs: ["*.md"] }));

  return { routes: app, fileWatch };
}
