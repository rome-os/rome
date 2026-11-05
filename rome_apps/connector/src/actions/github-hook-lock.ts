import { randomUUID } from "node:crypto";
import type { AppDbContext } from "@rome-os/app-runtime";
import { and, eq, lt } from "drizzle-orm";
import { settings } from "../db/schema.js";
import type { GithubHookTarget } from "./github-hook-client.js";

// Rome keeps one webhook per repo or org, and every change to it reads the hook,
// merges event types and writes it back. Two writers at once (a follow, a
// `defer`, Code Review's subscribe) can drop each other's events. The actions
// that write run in separate action workers, so the lock lives in this app's
// database: one row per target in the settings table, taken by inserting it.

/** How long a holder may keep the lock before another writer takes it over. */
const LEASE_MS = 60_000;
/** How long a writer waits for the lock before giving up. */
const WAIT_MS = 90_000;
const RETRY_MS = 100;

const keyOf = (target: GithubHookTarget) =>
  `lock:github-hook:${"repo" in target ? `repo:${target.repo}` : `org:${target.org}`}`.toLowerCase();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `task` while holding the lock on the target's webhook. Every action that
 * reads and writes a GitHub hook goes through here.
 */
export async function withGithubHookLock<T>(
  db: Pick<AppDbContext, "connection">,
  target: GithubHookTarget,
  task: () => Promise<T>,
  timing: { leaseMs?: number; waitMs?: number; retryMs?: number } = {},
): Promise<T> {
  const key = keyOf(target);
  const owner = randomUUID();
  const lease = timing.leaseMs ?? LEASE_MS;
  const deadline = Date.now() + (timing.waitMs ?? WAIT_MS);
  for (;;) {
    const now = new Date();
    // A lease past its expiry belongs to a writer that died: free it.
    await db.connection
      .delete(settings)
      .where(and(eq(settings.key, key), lt(settings.updatedAt, new Date(now.getTime() - lease))));
    const taken = await db.connection
      .insert(settings)
      .values({ key, value: owner, updatedAt: now })
      .onConflictDoNothing()
      .returning({ key: settings.key });
    if (taken.length > 0) break;
    if (Date.now() >= deadline) {
      throw new Error(
        "Another change to this GitHub webhook is still running. Try again in a minute.",
      );
    }
    await sleep(timing.retryMs ?? RETRY_MS);
  }
  try {
    return await task();
  } finally {
    await db.connection
      .delete(settings)
      .where(and(eq(settings.key, key), eq(settings.value, owner)));
  }
}
