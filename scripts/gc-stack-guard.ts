/**
 * Whether `gc-worktrees` may tear down a worktree's dev stack.
 *
 * gc names a worktree's stack after the worktree directory. A stack pinned by
 * ROME_DEV_SLUG (scripts/worktree-slug.sh) can share that name while another
 * checkout runs it, so gc leaves a stack alone when its containers were
 * started from another directory.
 */

import { realpathSync } from "node:fs";

/** Same rule as scripts/worktree-slug.sh. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * True when any of the stack's containers was started from a directory other
 * than `worktreePath`, or when Docker could not be asked (`ownerDirs` null).
 * `ownerDirs` is each container's compose working directory; a stack with no
 * containers has none and is not protected.
 */
export function startedElsewhere(
  ownerDirs: readonly string[] | null,
  worktreePath: string,
): boolean {
  if (ownerDirs === null) return true;
  return ownerDirs.some((dir) => dir !== worktreePath && real(dir) !== real(worktreePath));
}
