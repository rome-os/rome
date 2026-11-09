import {
  clearInstanceToken,
  isInstanceLinked,
  signerMode,
  recheckInstanceIdentity,
  type InstanceTokenStore,
  type ProveIdentityResult,
} from "./instance-identity.js";
import { createLogger } from "../logger.js";

const log = createLogger("instance-identity-heartbeat");

// State 1 is "authenticate: constant, invisible" — the boot-time
// prove gives an immediate read, and this heartbeat extends it so a token
// Rome Cloud revokes mid-session is noticed within one interval instead of only
// at the next boot. It only ever *removes* a credential the server has
// disowned; it never mints or refreshes one.
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15 * 60_000;

// Terminal signals: the instance is no longer valid. `unreachable`
// is a transient network miss and `no_token`/`unconfigured` are expected
// non-enrolled states — none of those should clear the credential.
const FATAL_STATES: ReadonlySet<ProveIdentityResult["status"]> = new Set(["revoked", "unknown"]);

export interface InstanceIdentityHeartbeatDeps {
  store: InstanceTokenStore;
  /** Override the cadence (tests). Defaults to 15 minutes. */
  intervalMs?: number;
  /** Inject the identity check (tests). Defaults to the real Rome Cloud call. */
  prove?: () => Promise<ProveIdentityResult>;
}

// Run one heartbeat tick. Exported for tests; the interval just calls this.
export async function runInstanceIdentityHeartbeatTick(
  deps: Pick<InstanceIdentityHeartbeatDeps, "store" | "prove">,
): Promise<void> {
  // No credential to verify — nothing to do (a not-yet-enrolled instance).
  // Signer mode always checks: it also registers the key, and finds a signer
  // that came back after being down.
  if (!signerMode() && !isInstanceLinked()) return;

  let result: ProveIdentityResult;
  try {
    result = await (deps.prove ?? (() => recheckInstanceIdentity(deps.store)))();
  } catch (err) {
    log.warn("instance identity heartbeat failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Signer mode clears what Rome Cloud rejected inside the check itself.
  if (!signerMode() && FATAL_STATES.has(result.status)) {
    await clearInstanceToken(deps.store);
    log.warn("instance token rejected by Rome Cloud; cleared local credential", {
      reason: result.status,
    });
  }
}

// Start the recurring check. Returns a stop function for graceful shutdown. The
// timer is unref'd so it never keeps the process alive on its own, and ticks
// never overlap (a slow Rome Cloud call won't stack up behind the interval).
export function startInstanceIdentityHeartbeat(deps: InstanceIdentityHeartbeatDeps): () => void {
  const intervalMs = deps.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  let inFlight = false;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      await runInstanceIdentityHeartbeatTick(deps);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
