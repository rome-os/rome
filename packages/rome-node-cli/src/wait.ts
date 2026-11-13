import { setTimeout as delay } from "node:timers/promises";
import type { ActionResponse } from "@rome-os/node-core";

export const MAX_WAIT_SECONDS = 900;
const RETRY_MS = 2_000;

/** Reads `--wait <seconds>`: absent is no wait. */
export function parseWait(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || seconds < 1 || seconds > MAX_WAIT_SECONDS)
    throw new Error(`--wait must be a whole number of seconds from 1 to ${MAX_WAIT_SECONDS}.`);
  return seconds;
}

/**
 * Runs `attempt` again while the device is not connected, until `seconds` have passed, and
 * returns the last result. Only `target_unavailable` is tried again: the Gateway never forwarded
 * that request, so nothing ran. Every other failure, `unknown_outcome` included, returns at once.
 */
export async function untilConnected<T>(
  attempt: () => Promise<T>,
  response: (result: T) => ActionResponse,
  seconds: number | undefined,
  clock = { now: Date.now, sleep: (ms: number) => delay(ms) },
): Promise<T> {
  const deadline = clock.now() + (seconds ?? 0) * 1000;
  for (;;) {
    const result = await attempt();
    const reply = response(result);
    const left = deadline - clock.now();
    if (reply.ok || reply.error.code !== "target_unavailable" || left <= 0) return result;
    await clock.sleep(Math.min(RETRY_MS, left));
  }
}
