import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getAssetsDir } from "../paths.js";

/** Largest file the store takes: webchat uploads now, `core:show_file` later. */
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
 * Copy `data` into the asset store under a new random name and return it.
 *
 * The bytes go to `.tmp/<id>` first and reach `<id>.<ext>` through `link()`,
 * which fails rather than replace an existing file, so a stored asset is never
 * overwritten and a half-written file is never visible under its final name.
 * The result is read-only (0444).
 */
export async function storeAssetBytes(
  data: Uint8Array,
  fileName: string,
  options: StoreAssetOptions = {},
): Promise<StoredAsset> {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES;
  if (data.byteLength > maxBytes) {
    throw new AssetTooLargeError(fileName || "File", maxBytes);
  }
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
    try {
      await writeFile(tmpPath, data, { flag: "wx", mode: 0o444 });
    } catch (error) {
      if (isExists(error)) continue;
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
    return {
      id,
      fileName: storedName,
      path,
      url: `/api/assets/${storedName}`,
      size: data.byteLength,
    };
  }
  throw new Error("Could not allocate an asset name");
}

function isExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "EEXIST";
}
