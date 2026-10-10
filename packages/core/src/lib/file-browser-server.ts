import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGzip } from "node:zlib";
import { watch, type FSWatcher } from "chokidar";
import type { Context } from "hono";
import { createLogger } from "../logger.js";

const log = createLogger("file-browser");

export interface TreeNode {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: TreeNode[];
}

export type ResolveResult =
  | {
      type: "file";
      path: string;
      kind: FileDescriptor["kind"];
      mimeType: string;
      editable: boolean;
      size: number;
      assetUrl: string | null;
    }
  | { type: "directory"; path: string }
  | { type: "missing"; path: string };

export interface FileBrowserScope {
  assetBasePath: string;
  logicalRoot: string;
  rootDir: string;
  /** Optional serializer for git commits. When set, every commit in
   * this scope runs through it, so file-save commits don't interleave with an
   * external writer (e.g. memory sync) on the same repo. Omitted scopes commit
   * directly, unchanged. */
  commitMutex?: <T>(fn: () => T | Promise<T>) => Promise<T>;
  afterCreate?: (created: {
    logicalPath: string;
    resolvedPath: string;
    type: "file" | "folder";
  }) => Promise<void> | void;
  createCommitTarget?: (
    resolvedPath: string,
    logicalPath: string,
    type: "file" | "folder",
  ) => GitCommitTarget | null;
  deleteCommitTarget?: (resolvedPath: string, logicalPath: string) => GitCommitTarget | null;
  beforeDelete?: (deleted: {
    logicalPath: string;
    resolvedPath: string;
    type: "directory" | "file";
  }) => Promise<unknown> | unknown;
  afterDelete?: (deleted: {
    logicalPath: string;
    prepared: unknown;
    resolvedPath: string;
    type: "directory" | "file";
  }) => Promise<void> | void;
  recoverMissingDelete?: (deleted: {
    logicalPath: string;
    resolvedPath: string;
  }) => Promise<{ message?: string } | null | undefined> | { message?: string } | null | undefined;
  rollbackDelete?: (deleted: {
    logicalPath: string;
    prepared: unknown;
    resolvedPath: string;
    type: "directory" | "file";
  }) => Promise<void> | void;
  ignoredNames?: string[];
  searchGlobs?: string[];
  historyTarget?: (resolvedPath: string, logicalPath: string) => GitTarget | null;
  renameCommitTarget?: (
    fromResolvedPath: string,
    toResolvedPath: string,
    fromLogicalPath: string,
    toLogicalPath: string,
  ) => GitMultiCommitTarget | null;
  saveCommitTarget?: (resolvedPath: string, logicalPath: string) => GitCommitTarget | null;
  uploadCommitTarget?: (
    files: Array<{ logicalPath: string; resolvedPath: string }>,
  ) => GitMultiCommitTarget | null;
}

interface GitTarget {
  cwd: string;
  gitPath: string;
}

interface GitCommitTarget extends GitTarget {
  message: string;
}

interface GitMultiCommitTarget {
  cwd: string;
  gitPaths: string[];
  message: string;
}

export const MAX_UPLOAD_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_UPLOAD_FILE_LABEL = "1 GB";

interface FileDescriptor {
  editable: boolean;
  kind: "text" | "image" | "video" | "audio" | "pdf" | "docx" | "binary";
  mimeType: string;
}

type Handler = (c: Context) => Promise<Response> | Response;

const DEFAULT_IGNORED_NAMES = [".git", ".gitkeep"];
const DEFAULT_TREE_DEPTH = 2;
const MAX_TREE_DEPTH = 20;
const TAR_BLOCK_BYTES = 512;
const DOT_ENTRY_SEARCH_GLOBS = ["!.*", "!**/.*", "!**/.*/**"];
const FILE_WATCH_EVENT_NAMES = new Set(["add", "addDir", "change", "unlink", "unlinkDir"]);
const FILE_WATCH_HEARTBEAT_INTERVAL_MS = 60_000;
const FILE_WATCH_HEARTBEAT_FAILURE_LIMIT = 2;
const FILE_WATCH_SSE_HEADERS = {
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
  "Transfer-Encoding": "chunked",
};

const IMAGE_MIME_TYPES = new Map<string, string>([
  [".apng", "image/apng"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

const VIDEO_MIME_TYPES = new Map<string, string>([
  [".mov", "video/quicktime"],
  [".mp4", "video/mp4"],
  [".m4v", "video/x-m4v"],
  [".ogv", "video/ogg"],
  [".webm", "video/webm"],
]);

const AUDIO_MIME_TYPES = new Map<string, string>([
  [".aac", "audio/aac"],
  [".flac", "audio/flac"],
  [".m4a", "audio/mp4"],
  [".mp3", "audio/mpeg"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".opus", "audio/ogg"],
  [".wav", "audio/wav"],
  [".weba", "audio/webm"],
]);

const PDF_MIME_TYPES = new Map<string, string>([[".pdf", "application/pdf"]]);

const DOCX_MIME_TYPES = new Map<string, string>([
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
]);

const TEXT_MIME_TYPES = new Map<string, string>([
  [".bash", "text/x-shellscript"],
  [".bat", "text/plain"],
  [".c", "text/x-c"],
  [".cc", "text/x-c"],
  [".cfg", "text/plain"],
  [".cjs", "text/javascript"],
  [".conf", "text/plain"],
  [".cpp", "text/x-c"],
  [".css", "text/css"],
  [".cs", "text/x-csharp"],
  [".cts", "text/typescript"],
  [".cxx", "text/x-c"],
  [".csv", "text/csv"],
  [".dart", "text/plain"],
  [".dockerfile", "text/plain"],
  [".env", "text/plain"],
  [".erl", "text/plain"],
  [".ex", "text/plain"],
  [".exs", "text/plain"],
  [".fish", "text/x-shellscript"],
  [".go", "text/x-go"],
  [".gradle", "text/plain"],
  [".graphql", "application/graphql-response+json"],
  [".h", "text/x-c"],
  [".hpp", "text/x-c"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".ini", "text/plain"],
  [".ipynb", "application/json"],
  [".java", "text/x-java-source"],
  [".js", "text/javascript"],
  [".json", "application/json"],
  [".jsonl", "application/x-ndjson"],
  [".jsx", "text/javascript"],
  [".kt", "text/plain"],
  [".kts", "text/plain"],
  [".less", "text/css"],
  [".log", "text/plain"],
  [".lua", "text/plain"],
  [".md", "text/markdown"],
  [".mdx", "text/mdx"],
  [".mjs", "text/javascript"],
  [".mts", "text/typescript"],
  [".php", "application/x-httpd-php"],
  [".pl", "text/plain"],
  [".pm", "text/plain"],
  [".proto", "text/plain"],
  [".ps1", "text/plain"],
  [".py", "text/x-python"],
  [".pyi", "text/x-python"],
  [".r", "text/plain"],
  [".rb", "text/x-ruby"],
  [".rs", "text/plain"],
  [".sass", "text/css"],
  [".scala", "text/plain"],
  [".scss", "text/css"],
  [".sh", "text/plain"],
  [".sql", "application/sql"],
  [".svelte", "text/plain"],
  [".swift", "text/plain"],
  [".toml", "application/toml"],
  [".txt", "text/plain"],
  [".ts", "text/typescript"],
  [".tsx", "text/tsx"],
  [".vue", "text/plain"],
  [".xml", "application/xml"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".zsh", "text/x-shellscript"],
]);

function isPreviewableTextAsset(file: FileDescriptor): boolean {
  return file.kind === "text" && file.mimeType === "text/html";
}

function createFileAssetUrl(
  scope: FileBrowserScope,
  logicalPath: string,
  file: FileDescriptor,
  stats: { mtimeMs: number; size: number },
): string | null {
  if (file.kind === "text" && !isPreviewableTextAsset(file)) {
    return null;
  }

  return createAssetUrl(scope, logicalPath, `${Math.trunc(stats.mtimeMs)}-${stats.size}`);
}

function isWithinDirectory(targetPath: string, directoryPath: string): boolean {
  const normalizedTarget = normalize(targetPath);
  const normalizedDirectory = normalize(directoryPath);
  return (
    normalizedTarget === normalizedDirectory ||
    normalizedTarget.startsWith(`${normalizedDirectory}${sep}`)
  );
}

function toLogicalPath(scope: FileBrowserScope, fullPath: string): string {
  const relPath = relative(scope.rootDir, fullPath);
  return relPath ? `${scope.logicalRoot}/${relPath}` : scope.logicalRoot;
}

function getIgnoredNames(scope: FileBrowserScope): Set<string> {
  return new Set([...(scope.ignoredNames ?? []), ...DEFAULT_IGNORED_NAMES]);
}

interface FileWatchSseMessage {
  data: string;
  event?: string;
  id?: string;
  retry?: number;
}

interface FileWatchSseStream {
  readonly aborted: boolean;
  readonly closed: boolean;
  readonly responseReadable: ReadableStream<Uint8Array>;
  abort(): void;
  close(): Promise<void>;
  onAbort(listener: () => void | Promise<void>): void;
  writeSSE(message: FileWatchSseMessage): Promise<void>;
}

function encodeFileWatchSseMessage(message: FileWatchSseMessage): Uint8Array {
  for (const key of ["event", "id"] as const) {
    if (message[key] && /[\r\n]/.test(message[key])) {
      throw new Error(`${key} must not contain "\\r" or "\\n"`);
    }
  }

  const dataLines = message.data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join("\n");
  const payload =
    [
      message.event && `event: ${message.event}`,
      dataLines,
      message.id && `id: ${message.id}`,
      message.retry && `retry: ${message.retry}`,
    ]
      .filter(Boolean)
      .join("\n") + "\n\n";

  return new TextEncoder().encode(payload);
}

function createFileWatchSseStream(): FileWatchSseStream {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const reader = readable.getReader();
  const writer = writable.getWriter();
  const abortSubscribers: Array<() => void | Promise<void>> = [
    async () => {
      await reader.cancel();
    },
  ];
  let aborted = false;
  let closed = false;

  const stream: FileWatchSseStream = {
    get aborted() {
      return aborted;
    },
    get closed() {
      return closed;
    },
    responseReadable: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel() {
        stream.abort();
      },
    }),
    abort() {
      if (aborted) return;
      aborted = true;
      for (const subscriber of abortSubscribers) {
        void Promise.resolve()
          .then(subscriber)
          .catch(() => {
            // Abort cleanup is best-effort and each subscriber is independent.
          });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      try {
        await writer.close();
      } catch {
        // The client may have already canceled the readable side.
      }
    },
    onAbort(listener) {
      abortSubscribers.push(listener);
    },
    async writeSSE(message) {
      if (aborted || closed) {
        throw new Error("SSE stream is closed");
      }
      await writer.write(encodeFileWatchSseMessage(message));
    },
  };

  return stream;
}

function isIgnoredEntryName(ignoredNames: Set<string>, name: string): boolean {
  return name.startsWith(".") || ignoredNames.has(name);
}

function isIgnoredWatchPath(scope: FileBrowserScope, fullPath: string): boolean {
  const relPath = relative(scope.rootDir, fullPath);
  if (!relPath) {
    return false;
  }
  if (relPath.startsWith("..") || isAbsolute(relPath)) {
    return true;
  }

  const ignoredNames = getIgnoredNames(scope);
  return relPath.split(sep).some((segment) => isIgnoredEntryName(ignoredNames, segment));
}

interface WatchDirectory {
  logicalPath: string;
  resolvedPath: string;
}

function getRequestedWatchDirectories(
  scope: FileBrowserScope,
  requestUrl: string,
): WatchDirectory[] {
  const searchParams = new URL(requestUrl).searchParams;
  const candidates = [scope.logicalRoot, ...searchParams.getAll("watch")];
  const directoriesByLogicalPath = new Map<string, WatchDirectory>();

  for (const candidate of candidates) {
    const resolvedPath = resolveScopedFilePath(scope, candidate);
    if (!resolvedPath || isIgnoredWatchPath(scope, resolvedPath)) {
      continue;
    }

    try {
      if (!existsSync(resolvedPath) || !statSync(resolvedPath).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }

    const logicalPath = toLogicalPath(scope, resolvedPath);
    directoriesByLogicalPath.set(logicalPath, { logicalPath, resolvedPath });
  }

  return Array.from(directoriesByLogicalPath.values()).sort((left, right) =>
    left.logicalPath.localeCompare(right.logicalPath),
  );
}

function describeFile(path: string): FileDescriptor {
  const extension = extname(path).toLowerCase();
  const imageMimeType = IMAGE_MIME_TYPES.get(extension);
  if (imageMimeType) {
    return { kind: "image", mimeType: imageMimeType, editable: false };
  }

  const videoMimeType = VIDEO_MIME_TYPES.get(extension);
  if (videoMimeType) {
    return { kind: "video", mimeType: videoMimeType, editable: false };
  }

  const audioMimeType = AUDIO_MIME_TYPES.get(extension);
  if (audioMimeType) {
    return { kind: "audio", mimeType: audioMimeType, editable: false };
  }

  const pdfMimeType = PDF_MIME_TYPES.get(extension);
  if (pdfMimeType) {
    return { kind: "pdf", mimeType: pdfMimeType, editable: false };
  }

  const docxMimeType = DOCX_MIME_TYPES.get(extension);
  if (docxMimeType) {
    return { kind: "docx", mimeType: docxMimeType, editable: false };
  }

  const textMimeType = TEXT_MIME_TYPES.get(extension);
  if (textMimeType) {
    return { kind: "text", mimeType: textMimeType, editable: true };
  }

  if (extension === "") {
    return { kind: "text", mimeType: "text/plain; charset=utf-8", editable: true };
  }

  return { kind: "binary", mimeType: "application/octet-stream", editable: false };
}

function resolveScopedFilePath(scope: FileBrowserScope, logicalPath: string): string | null {
  if (logicalPath !== scope.logicalRoot && !logicalPath.startsWith(`${scope.logicalRoot}/`)) {
    return null;
  }

  const relativePath =
    logicalPath === scope.logicalRoot ? "" : logicalPath.slice(scope.logicalRoot.length + 1);
  const resolvedPath = resolve(scope.rootDir, relativePath);
  return isWithinDirectory(resolvedPath, scope.rootDir) ? resolvedPath : null;
}

function encodeContentDispositionFileName(
  fileName: string,
  disposition: "attachment" | "inline" = "attachment",
): string {
  const fallbackName = fileName.replace(/[^\x20-\x7e]|[\\"]/g, "_") || "download";
  const encodedFileName = encodeRfc5987ValueChars(fileName);
  return `${disposition}; filename="${fallbackName}"; filename*=UTF-8''${encodedFileName}`;
}

function encodeRfc5987ValueChars(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function createAssetUrl(scope: FileBrowserScope, logicalPath: string, version?: string): string {
  const fileName = basename(logicalPath);
  const params = new URLSearchParams({ path: logicalPath });
  if (version) {
    params.set("v", version);
  }
  return `${scope.assetBasePath}/${encodeURIComponent(fileName)}?${params.toString()}`;
}

function toArchivePath(path: string): string {
  return path.split(sep).join("/");
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value.slice(0, length), offset, length, "utf-8");
}

function writeTarOctal(header: Buffer, value: number, offset: number, length: number): void {
  const text = value
    .toString(8)
    .padStart(length - 1, "0")
    .slice(-(length - 1));
  header.write(`${text}\0`, offset, length, "ascii");
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path) <= 100) {
    return { name: path, prefix: "" };
  }

  const parts = path.split("/");
  let name = parts.pop() ?? "";
  let prefix = parts.join("/");
  while (parts.length > 0 && (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)) {
    name = `${parts.pop()}/${name}`;
    prefix = parts.join("/");
  }

  if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) {
    throw new Error(`Archive path is too long: ${path}`);
  }

  return { name, prefix };
}

function createTarHeader(
  entryPath: string,
  options: { isDirectory: boolean; mode: number; mtime: Date; size: number },
): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  const { name, prefix } = splitUstarPath(entryPath);

  writeTarString(header, name, 0, 100);
  writeTarOctal(header, options.mode, 100, 8);
  writeTarOctal(header, 0, 108, 8);
  writeTarOctal(header, 0, 116, 8);
  writeTarOctal(header, options.isDirectory ? 0 : options.size, 124, 12);
  writeTarOctal(header, Math.floor(options.mtime.getTime() / 1000), 136, 12);
  header.fill(" ", 148, 156);
  header.write(options.isDirectory ? "5" : "0", 156, 1, "ascii");
  writeTarString(header, "ustar", 257, 6);
  writeTarString(header, "00", 263, 2);
  writeTarString(header, prefix, 345, 155);

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function createTarPadding(size: number): Buffer | null {
  const remainder = size % TAR_BLOCK_BYTES;
  return remainder === 0 ? null : Buffer.alloc(TAR_BLOCK_BYTES - remainder);
}

async function* walkArchiveEntries(
  scope: FileBrowserScope,
  directoryPath: string,
  archivePath: string,
): AsyncGenerator<Buffer | Uint8Array> {
  const ignoredNames = getIgnoredNames(scope);
  const directoryStats = lstatSync(directoryPath);
  yield createTarHeader(`${archivePath}/`, {
    isDirectory: true,
    mode: directoryStats.mode & 0o777,
    mtime: directoryStats.mtime,
    size: 0,
  });

  for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
    if (isIgnoredEntryName(ignoredNames, entry.name)) continue;

    const resolvedPath = join(directoryPath, entry.name);
    const entryArchivePath = `${archivePath}/${entry.name}`;
    const stats = lstatSync(resolvedPath);
    if (stats.isSymbolicLink()) continue;

    if (stats.isDirectory()) {
      yield* walkArchiveEntries(scope, resolvedPath, entryArchivePath);
      continue;
    }

    if (!stats.isFile()) continue;

    yield createTarHeader(entryArchivePath, {
      isDirectory: false,
      mode: stats.mode & 0o777,
      mtime: stats.mtime,
      size: stats.size,
    });

    for await (const chunk of createReadStream(resolvedPath)) {
      yield chunk;
    }

    const padding = createTarPadding(stats.size);
    if (padding) {
      yield padding;
    }
  }
}

function createDirectoryArchiveStream(
  scope: FileBrowserScope,
  directoryPath: string,
  archiveRootName: string,
): Readable {
  const tarStream = Readable.from(
    (async function* () {
      yield* walkArchiveEntries(scope, directoryPath, archiveRootName);
      yield Buffer.alloc(TAR_BLOCK_BYTES * 2);
    })(),
  );

  return tarStream.pipe(createGzip());
}

function createMultiPathArchiveStream(
  scope: FileBrowserScope,
  entries: Array<{ logicalPath: string; resolvedPath: string }>,
): Readable {
  const tarStream = Readable.from(
    (async function* () {
      for (const entry of entries) {
        const stats = lstatSync(entry.resolvedPath);
        const archivePath =
          entry.logicalPath === scope.logicalRoot
            ? scope.logicalRoot
            : entry.logicalPath.slice(scope.logicalRoot.length + 1);

        if (stats.isDirectory()) {
          yield* walkArchiveEntries(scope, entry.resolvedPath, toArchivePath(archivePath));
          continue;
        }

        yield createTarHeader(toArchivePath(archivePath), {
          isDirectory: false,
          mode: stats.mode & 0o777,
          mtime: stats.mtime,
          size: stats.size,
        });

        for await (const chunk of createReadStream(entry.resolvedPath)) {
          yield chunk;
        }

        const padding = createTarPadding(stats.size);
        if (padding) {
          yield padding;
        }
      }

      yield Buffer.alloc(TAR_BLOCK_BYTES * 2);
    })(),
  );

  return tarStream.pipe(createGzip());
}

function sanitizeUploadedRelativePath(filePath: string): string | null {
  const normalizedPath = filePath.replace(/\\/g, "/").trim();
  if (!normalizedPath || normalizedPath.startsWith("/")) {
    return null;
  }

  const segments = normalizedPath.split("/");
  if (
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    return null;
  }

  return segments.join("/");
}

function hasIgnoredUploadPathSegment(filePath: string, ignoredNames: Set<string>): boolean {
  return filePath.split("/").some((segment) => isIgnoredEntryName(ignoredNames, segment));
}

function sanitizeRenameName(name: string): string | null {
  const trimmedName = name.trim();
  if (
    !trimmedName ||
    trimmedName === "." ||
    trimmedName === ".." ||
    trimmedName.includes("/") ||
    trimmedName.includes("\\")
  ) {
    return null;
  }

  return trimmedName;
}

function isJsonRequest(c: Context): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().includes("application/json");
}

function commitFiles(scope: FileBrowserScope, target: GitMultiCommitTarget): Promise<boolean> {
  const run = (): boolean => {
    if (!existsSync(join(target.cwd, ".git")) || target.gitPaths.length === 0) {
      return false;
    }
    try {
      execFileSync("git", ["add", "-A", "--", ...target.gitPaths], {
        cwd: target.cwd,
        stdio: "pipe",
      });
      execFileSync("git", ["commit", "-m", target.message], {
        cwd: target.cwd,
        stdio: "pipe",
      });
      return true;
    } catch {
      return false;
    }
  };
  return scope.commitMutex ? scope.commitMutex(run) : Promise.resolve(run());
}

class UploadTooLargeError extends Error {
  readonly status = 413;

  constructor(fileLabel: string) {
    super(`"${fileLabel}" exceeds the ${MAX_UPLOAD_FILE_LABEL} upload limit`);
    this.name = "UploadTooLargeError";
  }
}

async function streamUploadedFile(
  file: File,
  resolvedPath: string,
  fileLabel = file.name,
): Promise<void> {
  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    throw new UploadTooLargeError(fileLabel);
  }

  let writtenBytes = 0;
  const source = Readable.fromWeb(file.stream() as unknown as NodeReadableStream<Uint8Array>);
  const sizeGuard = new Transform({
    transform(chunk, _encoding, callback) {
      writtenBytes += chunk.length;
      if (writtenBytes > MAX_UPLOAD_FILE_BYTES) {
        callback(new UploadTooLargeError(fileLabel));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    await pipeline(source, sizeGuard, createWriteStream(resolvedPath));
  } catch (error) {
    rmSync(resolvedPath, { force: true });
    throw error;
  }
}

function parseTreeDepth(value: string | undefined): number {
  if (!value) return DEFAULT_TREE_DEPTH;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TREE_DEPTH;

  return Math.min(parsed, MAX_TREE_DEPTH);
}

function buildTree(scope: FileBrowserScope, dirPath: string, depth: number): TreeNode[] {
  const ignoredNames = getIgnoredNames(scope);
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const nodes: TreeNode[] = [];

  for (const entry of entries) {
    if (isIgnoredEntryName(ignoredNames, entry.name)) continue;

    const fullPath = join(dirPath, entry.name);
    const logicalPath = toLogicalPath(scope, fullPath);

    if (entry.isDirectory()) {
      const node: TreeNode = {
        name: entry.name,
        path: logicalPath,
        type: "directory",
      };
      if (depth > 1) {
        node.children = buildTree(scope, fullPath, depth - 1);
      }
      nodes.push(node);
      continue;
    }

    nodes.push({ name: entry.name, path: logicalPath, type: "file" });
  }

  nodes.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

function parseRangeHeader(
  rangeHeader: string,
  size: number,
): { end: number; start: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start = rawStart ? Number.parseInt(rawStart, 10) : Number.NaN;
  let end = rawEnd ? Number.parseInt(rawEnd, 10) : Number.NaN;

  if (Number.isNaN(start)) {
    const suffixLength = end;
    if (suffixLength <= 0) return null;
    start = Math.max(size - suffixLength, 0);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }

  if (start < 0 || end < start || end >= size) return null;

  return { start, end };
}

function createStreamResponse(
  filePath: string,
  status: number,
  headers: Record<string, string>,
  start?: number,
  end?: number,
): Response {
  const stream = createReadStream(filePath, start !== undefined ? { start, end } : undefined);
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers, status });
}

function isCommandMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}

function findNearestGitRepoRoot(filePath: string, minimumPath: string): string | null {
  let currentPath = dirname(filePath);
  const normalizedMinimumPath = normalize(minimumPath);

  while (isWithinDirectory(currentPath, normalizedMinimumPath)) {
    if (existsSync(join(currentPath, ".git"))) {
      return currentPath;
    }

    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) break;
    currentPath = parentPath;
  }

  return existsSync(join(normalizedMinimumPath, ".git")) ? normalizedMinimumPath : null;
}

export function resolveNearestGitTarget(rootDir: string, resolvedPath: string): GitTarget | null {
  const repoRoot = findNearestGitRepoRoot(resolvedPath, rootDir);
  if (!repoRoot) return null;

  return {
    cwd: repoRoot,
    gitPath: relative(repoRoot, resolvedPath),
  };
}

export function createTreeHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPath = c.req.query("path") ?? scope.logicalRoot;
    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    try {
      if (!existsSync(resolvedPath)) {
        return c.json({ error: "Folder not found" }, 404);
      }
      if (!statSync(resolvedPath).isDirectory()) {
        return c.json({ error: "Path must be a folder" }, 400);
      }

      const depth = parseTreeDepth(c.req.query("depth"));
      return c.json(buildTree(scope, resolvedPath, depth));
    } catch (error) {
      log.error("failed to read directory", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: `Failed to read ${scope.logicalRoot} directory` }, 500);
    }
  };
}

export function createResolveHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPath = c.req.query("path");
    if (!logicalPath) {
      return c.json({ error: "path parameter is required" }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    try {
      if (!existsSync(resolvedPath)) {
        return c.json<ResolveResult>({ type: "missing", path: logicalPath });
      }

      const stats = statSync(resolvedPath);
      if (stats.isDirectory()) {
        return c.json<ResolveResult>({ type: "directory", path: logicalPath });
      }

      if (!stats.isFile()) {
        return c.json<ResolveResult>({ type: "missing", path: logicalPath });
      }

      const file = describeFile(logicalPath);
      return c.json<ResolveResult>({
        type: "file",
        path: logicalPath,
        kind: file.kind,
        mimeType: file.mimeType,
        editable: file.editable,
        size: stats.size,
        assetUrl: createFileAssetUrl(scope, logicalPath, file, stats),
      });
    } catch (error) {
      log.error("failed to resolve path", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to resolve path" }, 500);
    }
  };
}

export function createFileWatchEventsHandler(scope: FileBrowserScope): Handler {
  interface WatchState {
    key: string;
    subscribers: Set<FileWatchSseStream>;
    watcher: FSWatcher | null;
    watcherReady: boolean;
    watcherReadyPromise: Promise<void> | null;
  }

  const watchStates = new Map<string, WatchState>();

  const closeWatcherIfIdle = (state: WatchState) => {
    if (state.subscribers.size > 0 || !state.watcher) return;
    const watcherToClose = state.watcher;
    watchStates.delete(state.key);
    state.watcher = null;
    state.watcherReady = false;
    state.watcherReadyPromise = null;
    watcherToClose.close().catch((error) => {
      log.warn("failed to close file watcher", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const resetWatcher = (state: WatchState, watcherToClose: FSWatcher | null) => {
    if (!watcherToClose) return;
    if (state.watcher === watcherToClose) {
      watchStates.delete(state.key);
      state.watcher = null;
      state.watcherReady = false;
      state.watcherReadyPromise = null;
    }
    watcherToClose.close().catch((error) => {
      log.warn("failed to close file watcher", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  const ensureWatcher = (directories: WatchDirectory[]) => {
    const key = directories.map((directory) => directory.logicalPath).join("\0");
    let state = watchStates.get(key);
    if (!state) {
      state = {
        key,
        subscribers: new Set<FileWatchSseStream>(),
        watcher: null,
        watcherReady: false,
        watcherReadyPromise: null,
      };
      watchStates.set(key, state);
    }

    if (state.watcher) {
      return {
        readyPromise: state.watcherReady
          ? Promise.resolve()
          : (state.watcherReadyPromise ?? Promise.resolve()),
        state,
      };
    }

    state.watcher = watch(
      directories.map((directory) => directory.resolvedPath),
      {
        depth: 0,
        ignoreInitial: true,
        ignored: (rawPath) => {
          const resolvedPath = isAbsolute(rawPath) ? rawPath : resolve(scope.rootDir, rawPath);
          return isIgnoredWatchPath(scope, resolvedPath);
        },
        persistent: true,
      },
    );
    state.watcherReady = false;
    const currentWatcher = state.watcher;
    let rejectReadyPromise: ((reason?: unknown) => void) | null = null;
    state.watcherReadyPromise = new Promise<void>((resolveReady, rejectReady) => {
      rejectReadyPromise = rejectReady;
      currentWatcher.once("ready", () => {
        if (state.watcher !== currentWatcher) return;
        state.watcherReady = true;
        resolveReady();
      });
    });

    currentWatcher.on("all", (kind, rawPath) => {
      if (!FILE_WATCH_EVENT_NAMES.has(kind)) return;

      const resolvedPath = isAbsolute(rawPath) ? rawPath : resolve(scope.rootDir, rawPath);
      if (isIgnoredWatchPath(scope, resolvedPath)) return;

      const event = {
        at: Date.now(),
        kind,
        logicalRoot: scope.logicalRoot,
        path: toLogicalPath(scope, resolvedPath),
      };
      const payload = JSON.stringify(event);

      for (const subscriber of state.subscribers) {
        subscriber.writeSSE({ data: payload, event: "change" }).catch(() => {
          state.subscribers.delete(subscriber);
          closeWatcherIfIdle(state);
        });
      }
    });

    currentWatcher.on("error", (error) => {
      log.warn("file watcher failed", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!state.watcherReady && state.watcher === currentWatcher) {
        resetWatcher(state, currentWatcher);
        rejectReadyPromise?.(error);
      }
    });

    return { readyPromise: state.watcherReadyPromise, state };
  };

  return (c) => {
    const sse = createFileWatchSseStream();
    void (async () => {
      const directories = getRequestedWatchDirectories(scope, c.req.url);
      const { readyPromise, state } = ensureWatcher(directories);
      state.subscribers.add(sse);
      let closed = false;
      let heartbeatFailures = 0;
      let heartbeatInFlight = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let resolveClosed: (() => void) | null = null;
      let removeRequestAbortListener: (() => void) | null = null;

      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (heartbeatTimer != null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        state.subscribers.delete(sse);
        closeWatcherIfIdle(state);
        removeRequestAbortListener?.();
        removeRequestAbortListener = null;
        sse.abort();
        resolveClosed?.();
      };

      const abortPromise = new Promise<void>((resolveOpen) => {
        resolveClosed = resolveOpen;
        sse.onAbort(cleanup);
      });

      const requestSignal = c.req.raw.signal;
      if (requestSignal.aborted) {
        cleanup();
      } else {
        requestSignal.addEventListener("abort", cleanup, { once: true });
        removeRequestAbortListener = () => {
          requestSignal.removeEventListener("abort", cleanup);
        };
      }

      const startHeartbeat = () => {
        if (closed || heartbeatTimer != null) return;
        heartbeatTimer = setInterval(() => {
          if (heartbeatInFlight) {
            heartbeatFailures += 1;
            if (heartbeatFailures >= FILE_WATCH_HEARTBEAT_FAILURE_LIMIT) {
              cleanup();
            }
            return;
          }
          heartbeatInFlight = true;
          void Promise.resolve()
            .then(() =>
              sse.writeSSE({
                data: JSON.stringify({ at: Date.now(), logicalRoot: scope.logicalRoot }),
                event: "ping",
              }),
            )
            .then(() => {
              if (!closed) heartbeatFailures = 0;
            })
            .catch(() => {
              if (closed) return;
              heartbeatFailures += 1;
              if (heartbeatFailures >= FILE_WATCH_HEARTBEAT_FAILURE_LIMIT) {
                cleanup();
              }
            })
            .finally(() => {
              heartbeatInFlight = false;
            });
        }, FILE_WATCH_HEARTBEAT_INTERVAL_MS);
      };

      const writeReady = () =>
        sse.writeSSE({
          data: JSON.stringify({ at: Date.now(), logicalRoot: scope.logicalRoot }),
          event: "ready",
        });

      try {
        try {
          await Promise.race([readyPromise, abortPromise]);
        } catch {
          cleanup();
          return;
        }
        if (closed) return;

        try {
          await writeReady();
        } catch {
          cleanup();
          return;
        }
        if (closed) return;

        startHeartbeat();
        await abortPromise;
      } finally {
        cleanup();
        await sse.close();
      }
    })();

    return new Response(sse.responseReadable, { headers: FILE_WATCH_SSE_HEADERS });
  };
}

export function createFileGetHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPath = c.req.query("path");
    if (!logicalPath) {
      return c.json({ error: "path parameter is required" }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    if (!existsSync(resolvedPath)) {
      return c.json({ error: "File not found" }, 404);
    }

    try {
      const stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        return c.json({ error: "Path must be a file" }, 400);
      }

      const file = describeFile(logicalPath);
      return c.json({
        assetUrl: createFileAssetUrl(scope, logicalPath, file, stats),
        content: file.editable ? readFileSync(resolvedPath, "utf-8") : null,
        editable: file.editable,
        kind: file.kind,
        mimeType: file.mimeType,
        path: logicalPath,
        size: stats.size,
      });
    } catch (error) {
      log.error("failed to read file", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to read file" }, 500);
    }
  };
}

export function createFilePutHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    let body: { commit?: boolean; content?: string; path?: string };
    try {
      body = await c.req.json<{ commit?: boolean; content?: string; path?: string }>();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { commit = true, content, path: logicalPath } = body;
    if (!logicalPath || content === undefined) {
      return c.json({ error: "path and content are required" }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    try {
      const file = describeFile(logicalPath);
      if (!file.editable) {
        return c.json({ error: `Only text ${scope.logicalRoot} files can be edited` }, 400);
      }

      mkdirSync(dirname(resolvedPath), { recursive: true });
      writeFileSync(resolvedPath, content, "utf-8");

      let message = "Saved";
      const commitTarget = commit
        ? (scope.saveCommitTarget?.(resolvedPath, logicalPath) ?? null)
        : null;
      if (commitTarget && existsSync(join(commitTarget.cwd, ".git"))) {
        const commitSave = (): boolean => {
          try {
            execFileSync("git", ["add", "--", commitTarget.gitPath], {
              cwd: commitTarget.cwd,
              stdio: "pipe",
            });
            execFileSync("git", ["commit", "-m", commitTarget.message], {
              cwd: commitTarget.cwd,
              stdio: "pipe",
            });
            return true;
          } catch (error) {
            log.error("failed to commit file save", {
              logicalRoot: scope.logicalRoot,
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        };
        // Run through the scope's commit mutex when set so a memory
        // save can't interleave with a concurrent memory sync.
        const committed = scope.commitMutex ? await scope.commitMutex(commitSave) : commitSave();
        if (!committed) {
          return c.json({ error: "Saved to disk, but failed to create git commit" }, 500);
        }
        message = "Saved and committed";
      }

      return c.json({ message, success: true });
    } catch (error) {
      log.error("failed to write file", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to write file" }, 500);
    }
  };
}

export function createFileDeleteHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPath = c.req.query("path");
    if (!logicalPath) {
      return c.json({ error: "path parameter is required" }, 400);
    }

    if (logicalPath === scope.logicalRoot) {
      return c.json({ error: `Cannot delete ${scope.logicalRoot} root` }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    try {
      if (!existsSync(resolvedPath)) {
        const recovered = await scope.recoverMissingDelete?.({ logicalPath, resolvedPath });
        if (recovered) {
          return c.json({
            message: recovered.message ?? "Deleted item",
            success: true,
          });
        }
        return c.json({ error: "File not found" }, 404);
      }

      const stats = lstatSync(resolvedPath);
      const type = stats.isDirectory() ? "directory" : "file";
      const prepared = await scope.beforeDelete?.({ logicalPath, resolvedPath, type });
      try {
        rmSync(resolvedPath, { force: true, recursive: stats.isDirectory() });
      } catch (error) {
        try {
          await scope.rollbackDelete?.({ logicalPath, prepared, resolvedPath, type });
        } catch (rollbackError) {
          log.warn("failed to rollback delete preparation", {
            logicalRoot: scope.logicalRoot,
            error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          });
        }
        throw error;
      }

      let message = stats.isDirectory() ? "Deleted folder" : "Deleted file";
      const commitTarget = scope.deleteCommitTarget?.(resolvedPath, logicalPath) ?? null;
      if (
        commitTarget &&
        (await commitFiles(scope, {
          cwd: commitTarget.cwd,
          gitPaths: [commitTarget.gitPath],
          message: commitTarget.message,
        }))
      ) {
        message = `${message} and committed`;
      }

      await scope.afterDelete?.({ logicalPath, prepared, resolvedPath, type });

      return c.json({ message, success: true });
    } catch (error) {
      log.error("failed to delete file", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to delete file" }, 500);
    }
  };
}

export function createFileRenameHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    let body: { name?: string; parentPath?: string; path?: string };
    try {
      body = await c.req.json<{ name?: string; parentPath?: string; path?: string }>();
    } catch {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { name, parentPath, path: logicalPath } = body;
    if (!logicalPath || (name === undefined && !parentPath)) {
      return c.json({ error: "path and name or parentPath are required" }, 400);
    }

    if (logicalPath === scope.logicalRoot) {
      return c.json({ error: `Cannot rename ${scope.logicalRoot} root` }, 400);
    }

    const sanitizedName = name === undefined ? basename(logicalPath) : sanitizeRenameName(name);
    if (!sanitizedName || sanitizedName.includes("/")) {
      return c.json({ error: "Name must be a single file or folder name" }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    if (!existsSync(resolvedPath)) {
      return c.json({ error: "File not found" }, 404);
    }

    const resolvedParentPath = parentPath
      ? resolveScopedFilePath(scope, parentPath)
      : dirname(resolvedPath);
    if (!resolvedParentPath) {
      return c.json({ error: "Invalid destination folder" }, 400);
    }

    if (!existsSync(resolvedParentPath) || !statSync(resolvedParentPath).isDirectory()) {
      return c.json({ error: "Destination folder not found" }, 404);
    }

    if (
      lstatSync(resolvedPath).isDirectory() &&
      isWithinDirectory(resolvedParentPath, resolvedPath)
    ) {
      return c.json({ error: "Cannot move a folder into itself" }, 400);
    }

    const targetPath = resolve(resolvedParentPath, sanitizedName);
    if (!isWithinDirectory(targetPath, scope.rootDir)) {
      return c.json({ error: "Invalid name" }, 400);
    }

    const nextLogicalPath = toLogicalPath(scope, targetPath);
    if (nextLogicalPath === logicalPath) {
      return c.json({ message: "Location unchanged", path: logicalPath, success: true });
    }

    if (existsSync(targetPath)) {
      return c.json({ error: "A file or folder with that name already exists" }, 409);
    }

    try {
      const stats = lstatSync(resolvedPath);
      renameSync(resolvedPath, targetPath);

      const renamed = basename(resolvedPath) !== basename(targetPath);
      const moved = dirname(resolvedPath) !== dirname(targetPath);
      let message = stats.isDirectory()
        ? moved && !renamed
          ? "Moved folder"
          : "Renamed folder"
        : moved && !renamed
          ? "Moved file"
          : "Renamed file";
      const commitTarget =
        scope.renameCommitTarget?.(resolvedPath, targetPath, logicalPath, nextLogicalPath) ?? null;
      if (commitTarget && (await commitFiles(scope, commitTarget))) {
        message = `${message} and committed`;
      }

      return c.json({ message, path: nextLogicalPath, success: true });
    } catch (error) {
      log.error("failed to rename file", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to rename file" }, 500);
    }
  };
}

export function createFilePostHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    if (isJsonRequest(c)) {
      let body: { content?: string; path?: string; type?: string };
      try {
        body = await c.req.json<{ content?: string; path?: string; type?: string }>();
      } catch {
        return c.json({ error: "Invalid request body" }, 400);
      }

      const { content = "", path: logicalPath, type } = body;
      if (!logicalPath || (type !== "file" && type !== "folder")) {
        return c.json({ error: "path and type are required" }, 400);
      }

      if (logicalPath === scope.logicalRoot) {
        return c.json({ error: `Cannot create ${scope.logicalRoot} root` }, 400);
      }

      const itemName = basename(logicalPath);
      if (!sanitizeRenameName(itemName)) {
        return c.json({ error: "Name must be a single file or folder name" }, 400);
      }

      const resolvedPath = resolveScopedFilePath(scope, logicalPath);
      if (!resolvedPath) {
        return c.json({ error: "Invalid path" }, 400);
      }

      if (existsSync(resolvedPath)) {
        return c.json({ error: "A file or folder with that name already exists" }, 409);
      }

      const parentPath = dirname(resolvedPath);
      if (!existsSync(parentPath) || !statSync(parentPath).isDirectory()) {
        return c.json({ error: "Destination folder not found" }, 404);
      }

      try {
        if (type === "folder") {
          mkdirSync(resolvedPath);
          await scope.afterCreate?.({ logicalPath, resolvedPath, type: "folder" });
          return c.json({ message: "Created folder", path: logicalPath, success: true });
        }

        const file = describeFile(logicalPath);
        if (!file.editable) {
          return c.json({ error: `Only text ${scope.logicalRoot} files can be created` }, 400);
        }

        writeFileSync(resolvedPath, content, "utf-8");
        await scope.afterCreate?.({ logicalPath, resolvedPath, type: "file" });

        let message = "Created file";
        const commitTarget = scope.createCommitTarget?.(resolvedPath, logicalPath, "file") ?? null;
        if (
          commitTarget &&
          (await commitFiles(scope, {
            cwd: commitTarget.cwd,
            gitPaths: [commitTarget.gitPath],
            message: commitTarget.message,
          }))
        ) {
          message = "Created file and committed";
        }

        return c.json({ message, path: logicalPath, success: true });
      } catch (error) {
        log.error("failed to create file browser item", {
          logicalRoot: scope.logicalRoot,
          error: error instanceof Error ? error.message : String(error),
        });
        return c.json({ error: "Failed to create item" }, 500);
      }
    }

    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch {
      return c.json({ error: "Invalid form data" }, 400);
    }

    const rawPath = formData.get("path");
    const logicalPath = typeof rawPath === "string" && rawPath ? rawPath : scope.logicalRoot;
    const resolvedDirectory = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedDirectory) {
      return c.json({ error: "Invalid path" }, 400);
    }

    if (existsSync(resolvedDirectory) && !statSync(resolvedDirectory).isDirectory()) {
      return c.json({ error: "Upload target must be a directory" }, 400);
    }

    const files = formData.getAll("files").filter((value): value is File => value instanceof File);
    const uploadPaths = formData.getAll("paths");
    if (files.length === 0) {
      return c.json({ error: "At least one file is required" }, 400);
    }

    const uploadRequests: Array<{ file: File; resolvedPath: string; sanitizedPath: string }> = [];
    const ignoredNames = getIgnoredNames(scope);
    for (const file of files) {
      const rawUploadPath = uploadPaths.shift();
      const requestedRelativePath =
        typeof rawUploadPath === "string" && rawUploadPath ? rawUploadPath : file.name;
      const sanitizedPath = sanitizeUploadedRelativePath(requestedRelativePath);
      if (!sanitizedPath) {
        return c.json({ error: "Invalid file name" }, 400);
      }
      if (hasIgnoredUploadPathSegment(sanitizedPath, ignoredNames)) {
        return c.json({ error: "Ignored file paths cannot be uploaded" }, 400);
      }

      const resolvedPath = resolve(resolvedDirectory, sanitizedPath);
      if (!isWithinDirectory(resolvedPath, resolvedDirectory)) {
        return c.json({ error: "Invalid file name" }, 400);
      }

      uploadRequests.push({ file, resolvedPath, sanitizedPath });
    }

    const uploadedFiles: Array<{ logicalPath: string; resolvedPath: string; size: number }> = [];
    try {
      mkdirSync(resolvedDirectory, { recursive: true });

      for (const { file, resolvedPath, sanitizedPath } of uploadRequests) {
        mkdirSync(dirname(resolvedPath), { recursive: true });
        await streamUploadedFile(file, resolvedPath, sanitizedPath);
        uploadedFiles.push({
          logicalPath: toLogicalPath(scope, resolvedPath),
          resolvedPath,
          size: file.size,
        });
      }

      if (uploadedFiles.length === 0) {
        return c.json({ error: "No valid files to upload" }, 400);
      }

      let message =
        uploadedFiles.length === 1 ? "Uploaded 1 file" : `Uploaded ${uploadedFiles.length} files`;
      const commitTarget =
        scope.uploadCommitTarget?.(
          uploadedFiles.map(({ logicalPath: uploadedPath, resolvedPath }) => ({
            logicalPath: uploadedPath,
            resolvedPath,
          })),
        ) ?? null;
      if (commitTarget && (await commitFiles(scope, commitTarget))) {
        message = `${message} and committed`;
      }

      return c.json({
        files: uploadedFiles.map(({ logicalPath: uploadedPath, size }) => ({
          path: uploadedPath,
          size,
        })),
        message,
        success: true,
      });
    } catch (error) {
      for (const uploadedFile of uploadedFiles) {
        rmSync(uploadedFile.resolvedPath, { force: true });
      }

      if (error instanceof UploadTooLargeError) {
        return c.json({ error: error.message }, error.status);
      }

      log.error("failed to upload files", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to upload files" }, 500);
    }
  };
}

export function createHistoryHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPath = c.req.query("path");
    if (!logicalPath) {
      return c.json({ error: "path parameter is required" }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    const target = scope.historyTarget?.(resolvedPath, logicalPath) ?? null;
    if (!target || !existsSync(join(target.cwd, ".git"))) {
      return c.json([]);
    }

    try {
      const output = execFileSync(
        "git",
        ["log", "--oneline", "-20", "--format=%H|%s|%aI", "--", target.gitPath],
        { cwd: target.cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
      );

      const entries = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash, message, date] = line.split("|");
          return { date, hash, message };
        });

      return c.json(entries);
    } catch {
      return c.json([]);
    }
  };
}

export function createSearchHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const query = c.req.query("q");
    if (!query || query.trim().length === 0) {
      return c.json({ error: "q parameter is required" }, 400);
    }

    try {
      const args = [
        "--line-number",
        "--no-heading",
        "--color",
        "never",
        "--fixed-strings",
        "--smart-case",
        ...(scope.searchGlobs ?? []).flatMap((pattern) => ["--glob", pattern]),
        ...DOT_ENTRY_SEARCH_GLOBS.flatMap((pattern) => ["--glob", pattern]),
        query,
        ".",
      ];
      const output = execFileSync("rg", args, {
        cwd: scope.rootDir,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const results = output
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(0, 100)
        .map((line) => {
          const match = line.match(/^(?:\.\/)?(.+?):(\d+):(.*)$/);
          if (!match) return null;
          return {
            content: match[3].trim(),
            file: `${scope.logicalRoot}/${match[1]}`,
            line: Number.parseInt(match[2], 10),
          };
        })
        .filter(Boolean);

      return c.json(results);
    } catch (error) {
      if (
        (typeof error === "object" &&
          error !== null &&
          "status" in error &&
          (error as { status?: number }).status === 1) ||
        isCommandMissing(error)
      ) {
        return c.json([]);
      }
      log.error("failed to search files", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to search files" }, 500);
    }
  };
}

export function createAssetHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPath = c.req.query("path");
    if (!logicalPath) {
      return c.json({ error: "path parameter is required" }, 400);
    }

    const resolvedPath = resolveScopedFilePath(scope, logicalPath);
    if (!resolvedPath) {
      return c.json({ error: "Invalid path" }, 400);
    }

    if (!existsSync(resolvedPath)) {
      return c.json({ error: "File not found" }, 404);
    }

    try {
      const file = describeFile(logicalPath);
      const { size } = statSync(resolvedPath);
      const fileName = basename(resolvedPath);
      const baseHeaders: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Disposition": encodeContentDispositionFileName(fileName, "inline"),
        "Content-Length": String(size),
        "Content-Type": file.mimeType,
      };

      if (
        file.kind === "video" ||
        file.kind === "audio" ||
        file.kind === "pdf" ||
        file.kind === "docx"
      ) {
        const rangeHeader = c.req.header("range");
        if (rangeHeader) {
          const range = parseRangeHeader(rangeHeader, size);
          if (!range) {
            return new Response(null, {
              headers: {
                "Accept-Ranges": "bytes",
                "Cache-Control": "no-store",
                "Content-Range": `bytes */${size}`,
              },
              status: 416,
            });
          }

          return createStreamResponse(
            resolvedPath,
            206,
            {
              ...baseHeaders,
              "Content-Length": String(range.end - range.start + 1),
              "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
            },
            range.start,
            range.end,
          );
        }
      }

      return createStreamResponse(resolvedPath, 200, baseHeaders);
    } catch (error) {
      log.error("failed to read asset", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to read asset" }, 500);
    }
  };
}

export function createDownloadHandler(scope: FileBrowserScope): Handler {
  return async (c) => {
    const logicalPaths = Array.from(new Set(new URL(c.req.url).searchParams.getAll("path")));
    if (logicalPaths.length === 0) {
      return c.json({ error: "path parameter is required" }, 400);
    }
    const entries: Array<{ logicalPath: string; resolvedPath: string }> = [];
    for (const path of logicalPaths) {
      const resolvedPath = resolveScopedFilePath(scope, path);
      if (!resolvedPath) {
        return c.json({ error: "Invalid path" }, 400);
      }
      if (!existsSync(resolvedPath)) {
        return c.json({ error: "File not found" }, 404);
      }
      entries.push({ logicalPath: path, resolvedPath });
    }

    const resolvedPath = entries[0].resolvedPath;
    const logicalPath = entries[0].logicalPath;

    try {
      const stats = lstatSync(resolvedPath);
      if (stats.isSymbolicLink()) {
        return c.json({ error: "Symbolic links cannot be downloaded" }, 400);
      }

      if (entries.length > 1) {
        for (const entry of entries) {
          const entryStats = lstatSync(entry.resolvedPath);
          if (entryStats.isSymbolicLink()) {
            return c.json({ error: "Symbolic links cannot be downloaded" }, 400);
          }
          if (!entryStats.isFile() && !entryStats.isDirectory()) {
            return c.json({ error: "Only files and directories can be downloaded" }, 400);
          }
        }

        const archiveFileName = `${scope.logicalRoot}-selection.tar.gz`;
        const archiveStream = createMultiPathArchiveStream(scope, entries);

        return new Response(Readable.toWeb(archiveStream) as ReadableStream, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Disposition": encodeContentDispositionFileName(archiveFileName),
            "Content-Type": "application/gzip",
          },
        });
      }

      if (stats.isDirectory()) {
        const archiveRootName =
          logicalPath === scope.logicalRoot ? scope.logicalRoot : basename(resolvedPath);
        const archiveFileName = `${archiveRootName}.tar.gz`;
        const archiveStream = createDirectoryArchiveStream(
          scope,
          resolvedPath,
          toArchivePath(archiveRootName),
        );

        return new Response(Readable.toWeb(archiveStream) as ReadableStream, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Disposition": encodeContentDispositionFileName(archiveFileName),
            "Content-Type": "application/gzip",
          },
        });
      }

      if (!stats.isFile()) {
        return c.json({ error: "Only files and directories can be downloaded" }, 400);
      }

      const file = describeFile(logicalPath);
      const fileName = basename(resolvedPath);
      return createStreamResponse(resolvedPath, 200, {
        "Cache-Control": "no-store",
        "Content-Disposition": encodeContentDispositionFileName(fileName),
        "Content-Length": String(stats.size),
        "Content-Type": file.mimeType,
      });
    } catch (error) {
      log.error("failed to download file", {
        logicalRoot: scope.logicalRoot,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to download file" }, 500);
    }
  };
}
