import type { ActiveTrigger, ComposioClient } from "./composio-client.js";

const ACTIVE_TRIGGERS_TTL_MS = 5 * 60_000;

// The project's active triggers, kept briefly so listing sources does not ask
// Composio each time. Arming a trigger drops them, so a check after it reads
// the trigger it armed.
let kept: { triggers: ActiveTrigger[]; at: number } | null = null;

/** The project's active triggers, read at most once per five minutes. A failed read throws and is not kept. */
export async function keptActiveTriggers(
  client: Pick<ComposioClient, "listActiveTriggers">,
  now = Date.now(),
): Promise<ActiveTrigger[]> {
  if (kept && now - kept.at < ACTIVE_TRIGGERS_TTL_MS) return kept.triggers;
  const triggers = await client.listActiveTriggers();
  kept = { triggers, at: now };
  return triggers;
}

/** Drops the kept triggers, after this instance arms one. */
export function forgetActiveTriggers(): void {
  kept = null;
}
