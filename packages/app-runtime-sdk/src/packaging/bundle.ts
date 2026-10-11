import { basename, dirname } from "node:path";
import { create as tarCreate } from "tar";

// Mirrors the `rome publish` CLI's default excludes. Installed bundles carry
// node_modules (deps are installed at materialize time), but store bundles
// never do — the installer re-installs deps on the receiving side.
const EXCLUDED_SEGMENTS = new Set(["node_modules", ".git", ".DS_Store", ".rome_store"]);

/**
 * Pack `rootPath` (a directory containing `app.yaml` at its root) into a
 * single-rooted gzipped tarball, byte-stable across runs so the sha256 doubles
 * as the bundle's content identity.
 */
export async function packBundle(rootPath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = tarCreate(
    {
      gzip: true,
      cwd: dirname(rootPath),
      portable: true,
      noMtime: true,
      // tar emits paths with forward slashes regardless of platform.
      filter: (entryPath) =>
        !entryPath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment)),
    },
    [basename(rootPath)],
  );
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return Buffer.concat(chunks);
}
