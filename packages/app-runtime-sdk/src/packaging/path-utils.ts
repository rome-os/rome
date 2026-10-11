import { statSync } from "node:fs";
import { relative, resolve } from "node:path";

/**
 * Resolve `relativePath` against `baseDir` and reject paths that escape the
 * base. Returns the absolute resolved path. The empty relative resolves to
 * the base itself (treated as inside the base).
 */
export function resolvePathWithinBase(
  baseDir: string,
  relativePath: string,
  description: string,
): string {
  const resolved = resolve(baseDir, relativePath);
  const rel = relative(baseDir, resolved);
  if (rel === "") return resolved;
  if (rel.startsWith("..")) {
    throw new Error(`Invalid ${description}: "${relativePath}" escapes ${baseDir}`);
  }
  return resolved;
}

/** Whether `path` exists and is a regular file; never throws. */
export function safeIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Whether `path` exists and is a directory; never throws. */
export function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
