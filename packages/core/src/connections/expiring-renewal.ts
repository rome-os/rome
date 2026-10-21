import type { ConnectionRegistry } from "./registry.js";

/** How often to look for credentials nearing expiry. */
const RENEWAL_INTERVAL_MS = 5 * 60 * 1000;
/** Renew a credential once it expires within this window. Twice the interval, so
 *  a credential gets at least two attempts before it lapses (Shopify's hourly
 *  token renews around its 50-minute mark). */
const RENEWAL_WINDOW_MS = 2 * RENEWAL_INTERVAL_MS;

/**
 * Renew expiring credentials on a timer, ahead of their expiry. The first pass
 * runs at once, so a credential expiring right after boot (or one boot couldn't
 * renew) doesn't wait a full interval. Returns a stop function for shutdown.
 * Passes never overlap: a slow pass delays the next one rather than running
 * alongside it.
 */
export function startExpiringCredentialRenewal(
  registry: Pick<ConnectionRegistry, "renewExpiring">,
  opts: { intervalMs?: number; windowMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? RENEWAL_INTERVAL_MS;
  const windowMs = opts.windowMs ?? RENEWAL_WINDOW_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const pass = () => {
    timer = null;
    void registry.renewExpiring(windowMs).finally(schedule);
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(pass, intervalMs);
    timer.unref?.();
  };
  pass();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
