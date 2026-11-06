import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getProfileAppsDir } from "../../paths.js";
import { appIdToPathSegment } from "../packaging/app-id.js";

/**
 * Bumped whenever the card's look or inputs change. It is part of the on-disk
 * name, so a card rendered by an older format is simply never read again and
 * the next event renders a fresh one — no timestamp guessing.
 */
export const CARD_FORMAT_VERSION = 2;

/**
 * `host` is optional on the calls that name a card file. Omitted, the store's
 * live host is used. A renderer passes the host it drew the card with, so the
 * file lands under that host's name even if the live host changed meanwhile.
 */
export interface OgImageStore {
  path(appId: string, host?: string | null): string;
  write(appId: string, png: Buffer, host?: string | null): Promise<void>;
  stat(appId: string, host?: string | null): Promise<{ mtimeMs: number } | null>;
  read(appId: string): Promise<Buffer | null>;
  remove(appId: string): Promise<void>;
}

function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/**
 * One PNG per app under `<profile>/apps/og/`, keyed by the encoded app id and,
 * when the instance has one, the public host the card prints. The host is part
 * of the name for the same reason as the format version: a card drawn for
 * another host (an instance that took its tenant address after the card was
 * rendered) is simply never read again, and the next event renders a fresh one.
 * `host` is read on every call that is not given one, so the store follows a host
 * that changes.
 */
export function createOgImageStore(
  rootDir: string = join(getProfileAppsDir(), "og"),
  host: () => string | null = () => null,
): OgImageStore {
  const path = (appId: string, explicitHost?: string | null) => {
    const current = explicitHost === undefined ? host() : explicitHost;
    const hostKey = current
      ? `.${createHash("sha256").update(current).digest("hex").slice(0, 8)}`
      : "";
    return join(rootDir, `${appIdToPathSegment(appId)}.v${CARD_FORMAT_VERSION}${hostKey}.png`);
  };
  return {
    path,
    async write(appId, png, explicitHost) {
      await mkdir(rootDir, { recursive: true });
      const target = path(appId, explicitHost);
      const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmp, png);
      try {
        await rename(tmp, target); // atomic swap; concurrent writers: last one wins
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },
    async stat(appId, explicitHost) {
      try {
        const s = await stat(path(appId, explicitHost));
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
