import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, realpath, unlink, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { getAssetsDir, getProfileMemoryDir, getProjectsRoot } from "../paths.js";

/** Largest file the store takes: chat uploads and `core:show_file`. */
export const MAX_ASSET_BYTES = 100 * 1024 * 1024;

export interface StoredAsset {
  id: string;
  /** `<id>.<ext>`: the name on disk and in the URL. */
  fileName: string;
  path: string;
  url: string;
  size: number;
}

export class AssetTooLargeError extends Error {
  constructor(label: string, maxBytes: number) {
    super(`${label} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
    this.name = "AssetTooLargeError";
  }
}

/** A file `storeAssetFromPath` refuses; the message says why, in one line. */
export class AssetSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetSourceError";
  }
}

export interface StoreAssetOptions {
  maxBytes?: number;
  /** Test seam: the id for each attempt. */
  generateId?: () => string;
}

const MAX_ID_ATTEMPTS = 8;

/** The lowercased extension of `fileName` when it is `[a-z0-9]{1,8}`, else `bin`. */
export function assetExtension(fileName: string): string {
  const extension = extname(fileName).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : "bin";
}

/**
 * Publish a new asset: `write` fills `.tmp/<id>` (and must create it
 * exclusively), then `link()` gives it its final name. `link()` fails rather
 * than replace an existing file, so a stored asset is never overwritten, and a
 * half-written file is never visible under its final name. The result is
 * read-only (0444).
 */
async function publish(
  fileName: string,
  options: StoreAssetOptions,
  write: (tmpPath: string) => Promise<number>,
): Promise<StoredAsset> {
  const generateId = options.generateId ?? (() => randomBytes(16).toString("hex"));
  const extension = assetExtension(fileName);
  const dir = getAssetsDir();
  const tmpDir = join(dir, ".tmp");
  await mkdir(tmpDir, { recursive: true });

  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
    const id = generateId();
    const storedName = `${id}.${extension}`;
    const path = join(dir, storedName);
    const tmpPath = join(tmpDir, id);
    let size: number;
    try {
      size = await write(tmpPath);
    } catch (error) {
      if (isExists(error)) continue;
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
    try {
      await link(tmpPath, path);
    } catch (error) {
      await unlink(tmpPath).catch(() => {});
      if (isExists(error)) continue;
      throw error;
    }
    await unlink(tmpPath).catch(() => {});
    await chmod(path, 0o444);
    return { id, fileName: storedName, path, url: `/api/assets/${storedName}`, size };
  }
  throw new Error("Could not allocate an asset name");
}

/** Copy `data` into the asset store under a new random name. */
export async function storeAssetBytes(
  data: Uint8Array,
  fileName: string,
  options: StoreAssetOptions = {},
): Promise<StoredAsset> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  if (data.byteLength > maxBytes) {
    throw new AssetTooLargeError(fileName || "File", maxBytes);
  }
  return publish(fileName, options, async (tmpPath) => {
    await writeFile(tmpPath, data, { flag: "wx", mode: 0o444 });
    return data.byteLength;
  });
}

// Folders and file names that never go into the store, even inside an allowed
// folder: keys, credentials, git internals and databases.
const SENSITIVE_DIRECTORIES = new Set([".ssh", ".git", ".aws", ".gnupg", ".docker", ".kube"]);

function isSensitiveName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith(".pub")) return false;
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    /\.(pem|key|p12|pfx|db|sqlite|sqlite3|db-wal|db-shm)$/.test(lower) ||
    /^id_(rsa|ed25519|ecdsa)/.test(lower) ||
    lower.includes("credential") ||
    lower.includes("secret")
  );
}

export interface StoreAssetFromPathOptions extends StoreAssetOptions {
  /** Test seam: the folders a file may come from. Default: projects, memory and the assets folder. */
  roots?: string[];
}

/**
 * Copy a local file into the asset store, as `core:show_file` does. The path
 * must be absolute and, once its links are resolved, inside the projects
 * folder, the memory folder or the assets folder, and not a sensitive file.
 * The resolved path is opened once without following links and the bytes are
 * copied from that descriptor, so the file cannot be swapped after the check.
 */
export async function storeAssetFromPath(
  path: string,
  options: StoreAssetFromPathOptions = {},
): Promise<StoredAsset> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  if (!isAbsolute(path)) throw new AssetSourceError("Path must be an absolute path");

  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    throw new AssetSourceError(`File not found: ${path}`);
  }

  const roots = await Promise.all(
    (options.roots ?? [getProjectsRoot(), getProfileMemoryDir(), getAssetsDir()]).map((root) =>
      realpath(root).catch(() => null),
    ),
  );
  let inside: string[] | null = null;
  for (const root of roots) {
    if (!root) continue;
    const rel = relative(root, resolved);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      inside = rel.split(sep);
      break;
    }
  }
  if (!inside) {
    throw new AssetSourceError("File is outside the folders chat can show (projects, memory)");
  }
  const name = basename(resolved);
  if (
    inside.some((part) => SENSITIVE_DIRECTORIES.has(part.toLowerCase())) ||
    isSensitiveName(name)
  ) {
    throw new AssetSourceError(`Refused: ${basename(path)} looks like a sensitive file`);
  }

  // O_NONBLOCK so that a FIFO cannot hang the open; fstat then refuses it.
  const handle = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new AssetSourceError(`File not found: ${path}`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new AssetSourceError(`Not a regular file: ${path}`);
    if (info.size > maxBytes) throw new AssetTooLargeError(basename(path), maxBytes);
    return await publish(name, options, async (tmpPath) => {
      if (info.size === 0) {
        await writeFile(tmpPath, new Uint8Array(), { flag: "wx", mode: 0o444 });
        return 0;
      }
      // Only the bytes fstat counted: a file that grows meanwhile is cut there.
      const out = await open(
        tmpPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o444,
      );
      await pipeline(
        handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false }),
        out.createWriteStream(),
      );
      return info.size;
    });
  } finally {
    await handle.close();
  }
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
