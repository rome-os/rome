import { statfsSync } from "node:fs";
import { getProfileDir } from "../paths.js";

/** How full the volume holding the instance's data is. */
export interface DiskUsage {
  /** The directory the reading was taken for. */
  path: string;
  totalBytes: number;
  /** Bytes an unprivileged writer can still use, which is what Rome's writes
   * get. The kernel's reserved blocks are not counted. */
  freeBytes: number;
}

/** The volume is low on space while less than this share of it is free. One
 * line, as for memory. */
export const DISK_LOW_FRACTION = 0.1;

/** The slice of `statfsSync` the reader uses, so a test can hand it numbers. */
export type StatfsLike = (path: string) => { bsize: number; blocks: number; bavail: number };

/**
 * Reads how full the volume under `path` is. Defaults to the profile directory
 * (`~/.rome/<profile>`), which holds the database, the chats and the installed
 * apps, so it is the volume whose exhaustion stops Rome. Returns null when the
 * volume cannot be read, so a caller shows nothing rather than a wrong number.
 */
export function readDiskUsage(
  path: string = getProfileDir(),
  statfs: StatfsLike = statfsSync,
): DiskUsage | null {
  try {
    const stats = statfs(path);
    const totalBytes = stats.blocks * stats.bsize;
    if (!(totalBytes > 0)) return null;
    const freeBytes = Math.min(totalBytes, Math.max(0, stats.bavail * stats.bsize));
    return { path, totalBytes, freeBytes };
  } catch {
    return null;
  }
}
