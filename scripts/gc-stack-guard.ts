/**
 * Which dev stack `gc-worktrees` may tear down along with a worktree.
 *
 * `pnpm dev:all` names a stack after the checkout's branch, or after
 * `ROME_DEV_SLUG` when that is set (see scripts/worktree-slug.sh). One pinned
 * stack can then serve every branch of a checkout, so a merged worktree whose
 * name slugifies to the same value does not own it. Removing that worktree
 * must leave the stack and its home dir alone.
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

/** The slug `ROME_DEV_SLUG` pins, or null when it pins none. */
export function pinnedSlug(env: NodeJS.ProcessEnv): string | null {
  const slug = slugify(env.ROME_DEV_SLUG ?? "");
  return slug || null;
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return a === b || real(a) === real(b);
}

/** The file in a stack's home dir naming the checkout that last started it. */
export const OWNER_FILE = ".dev-stack-owner";

/**
 * Whether removing the worktree at `worktreePath` may also remove the stack
 * named `slug` and its home dir. Never when this shell pins that slug, and
 * never when the owner file or any container names another checkout.
 * Otherwise the owner file naming this worktree is enough. A stack started
 * before dev-up.sh wrote that file needs at least one container, all started
 * from this worktree.
 *
 * `owner` is the owner file's content, or null when there is none.
 * `ownerDirs` is the compose working directory of each of the stack's
 * containers, or null when Docker could not be asked, which keeps the stack
 * since no container can then outvote the owner file. Any doubt keeps the
 * stack: deleting a home dir that belongs to another checkout loses its
 * database, while keeping one only leaves a directory to remove by hand.
 */
export function mayTearDownStack(input: {
  slug: string;
  worktreePath: string;
  pinned: string | null;
  owner: string | null;
  ownerDirs: readonly string[] | null;
}): boolean {
  if (input.pinned !== null && input.slug === input.pinned) return false;
  if (input.ownerDirs === null) return false;
  const mine = (dir: string) => samePath(dir, input.worktreePath);
  if (input.ownerDirs.some((dir) => !mine(dir))) return false;
  if (input.owner !== null) return mine(input.owner);
  return input.ownerDirs.length > 0;
}
