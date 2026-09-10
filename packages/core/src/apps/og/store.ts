import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProfileAppsDir } from "../../paths.js";
import { appIdToPathSegment } from "../packaging/app-id.js";

export interface OgImageStore {
  path(appId: string): string;
  write(appId: string, png: Buffer): Promise<void>;
  stat(appId: string): Promise<{ mtimeMs: number } | null>;
  read(appId: string): Promise<Buffer | null>;
  remove(appId: string): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** One PNG per app under `<profile>/apps/og/`, keyed by the encoded app id. */
export function createOgImageStore(
  rootDir: string = join(getProfileAppsDir(), "og"),
): OgImageStore {
  const path = (appId: string) => join(rootDir, `${appIdToPathSegment(appId)}.png`);
  return {
    path,
    async write(appId, png) {
      await mkdir(rootDir, { recursive: true });
      const target = path(appId);
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, png);
      try {
        await rename(tmp, target); // atomic swap; concurrent writers: last one wins
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
    async stat(appId) {
      try {
        const s = await stat(path(appId));
        return { mtimeMs: s.mtimeMs };
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async read(appId) {
      try {
        return await readFile(path(appId));
      } catch (err) {
        if (isEnoent(err)) return null;
        throw err;
      }
    },
    async remove(appId) {
      await rm(path(appId), { force: true });
    },
  };
}
