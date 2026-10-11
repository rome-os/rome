import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const WORKSPACE_HASH_EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".rome",
  ".rome_store",
  ".turbo",
]);

const ARTIFACT_HASH_EXCLUDED_DIRS = new Set(["node_modules", ".git", ".rome_store"]);

const HASH_EXCLUDED_FILES = new Set([".DS_Store"]);

/**
 * Deterministic content hash over a source workspace. Visits files in
 * sorted-relative-path order, hashing `<relPath>\0<bytes>\0` per entry.
 * Excludes build outputs and volatile dirs so that re-running the build
 * never changes the hash for unchanged source.
 *
 * Use this for SOURCE workspaces — not for packed artifacts, whose
 * `dist/` content is load-bearing. See `hashArtifact`.
 */
export async function hashWorkspace(workspaceRoot: string): Promise<string> {
  return hashDir(workspaceRoot, WORKSPACE_HASH_EXCLUDED_DIRS);
}

/**
 * Deterministic content hash over a packed app artifact dir. Identical to
 * `hashWorkspace` except `dist/` is included (it's the `appRoot` payload in
 * a packed artifact and must contribute to identity). Store listing metadata
 * stays out of runtime identity because publish uploads `.rome_store` as a
 * sidecar instead of bundling it into the installable app.
 */
export async function hashArtifact(artifactRoot: string): Promise<string> {
  return hashDir(artifactRoot, ARTIFACT_HASH_EXCLUDED_DIRS);
}

async function hashDir(rootDir: string, excludedDirs: ReadonlySet<string>): Promise<string> {
  const entries = await collectHashableFiles(rootDir, [], excludedDirs);
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hasher = createHash("sha256");
  for (const entry of entries) {
    hasher.update(entry.relPath);
    hasher.update("\0");
    const contents = await readFile(entry.absPath);
    hasher.update(contents);
    hasher.update("\0");
  }
  return hasher.digest("hex");
}

interface CollectedFile {
  relPath: string;
  absPath: string;
}

async function collectHashableFiles(
  rootDir: string,
  segments: readonly string[],
  excludedDirs: ReadonlySet<string>,
): Promise<CollectedFile[]> {
  const absDir = segments.length === 0 ? rootDir : join(rootDir, ...segments);
  const dirents = await readdir(absDir, { withFileTypes: true });
  const out: CollectedFile[] = [];
  for (const dirent of dirents) {
    if (HASH_EXCLUDED_FILES.has(dirent.name)) continue;
    const childSegments = [...segments, dirent.name];
    const relPath = childSegments.join("/");
    const absPath = join(rootDir, ...childSegments);

    if (excludedDirs.has(dirent.name)) continue;

    if (dirent.isDirectory()) {
      // Workspace hashing also skips nested `web/dist`; for packed artifacts
      // `web/dist` is part of the appRoot payload and must be hashed.
      if (
        excludedDirs.has("dist") &&
        childSegments[childSegments.length - 1] === "dist" &&
        childSegments[childSegments.length - 2] === "web"
      ) {
        continue;
      }
      const nested = await collectHashableFiles(rootDir, childSegments, excludedDirs);
      out.push(...nested);
      continue;
    }

    if (dirent.isFile() || dirent.isSymbolicLink()) {
      out.push({ relPath, absPath });
    }
  }
  return out;
}
