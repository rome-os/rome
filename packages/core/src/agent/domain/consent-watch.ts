import type { Trigger } from "@rome-os/app-runtime";

export const COMPUTER_CONSENT_EVENT = "computer.consent.changed";
export const COMPUTER_CONSENT_SOURCE = "rome-node";
const MAX_WATCH_MS = 10 * 60_000;

export interface ConsentWatchParams {
  deviceId: string;
  requestId: string;
  afterRevision?: number;
}

export function validateConsentWatch(
  trigger: Trigger,
  args: Record<string, unknown>,
  { allowExpired = false, now = Date.now() } = {},
): { watch?: ConsentWatchParams } | { error: string } {
  if (trigger.type !== "event-bus" || trigger.eventName !== COMPUTER_CONSENT_EVENT) return {};
  if (trigger.once !== true || trigger.sourcePattern !== COMPUTER_CONSENT_SOURCE)
    return { error: "computer.consent.changed requires a one-shot trigger from rome-node" };
  const filters = Array.isArray(trigger.filter) ? trigger.filter : [];
  const deviceId = filters.find((c) => c?.field === "deviceId")?.equals;
  const requestId = filters.find((c) => c?.field === "requestId")?.equals;
  if (
    filters.length !== 2 ||
    typeof deviceId !== "string" ||
    !deviceId.trim() ||
    typeof requestId !== "string" ||
    !requestId.trim()
  )
    return { error: "computer.consent.changed requires deviceId and requestId equality filters" };
  const { afterRevision, deadline } = args;
  if (
    afterRevision !== undefined &&
    (typeof afterRevision !== "number" || !Number.isSafeInteger(afterRevision) || afterRevision < 0)
  )
    return { error: "computer.consent.changed requires a nonnegative integer afterRevision" };
  const at = typeof deadline === "string" ? Date.parse(deadline) : NaN;
  if (!Number.isFinite(at) || at > now + MAX_WATCH_MS)
    return { error: "computer.consent.changed requires a deadline within ten minutes" };
  if (!allowExpired && at <= now)
    return { error: "computer.consent.changed requires a future deadline" };
  return { watch: { deviceId, requestId, afterRevision } };
}
