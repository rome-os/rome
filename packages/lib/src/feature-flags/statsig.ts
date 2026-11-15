import { Statsig } from "@statsig/statsig-node-core";
import { setFeatureGates, type FeatureGates } from "./index.js";
import { statsigUser } from "./user.js";

/**
 * Minimal sink for the backend's fail-closed warnings. Injected by the caller so
 * this package needs no dependency on any host's logging stack — core's `Logger`
 * (from `@rome-os/app-runtime`) satisfies it structurally, and Rome Cloud can pass
 * its own. Only `warn` is used: the gate hot path stays silent on success, and
 * only init/evaluation failures (which all fail closed) are surfaced.
 */
export interface FeatureFlagLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

/**
 * Bounds the one-time Statsig spec download. On timeout `checkGate` fails closed,
 * so a slow or unreachable Statsig can never wedge a caller or silently enable a
 * feature.
 */
const INIT_TIMEOUT_MS = 3000;

/**
 * Statsig-backed {@link FeatureGates}. The unit id maps to the Statsig user's
 * `userID`, so allowlists and percentage ramps target specific units, and
 * `email` to its `email`, so a rule can match on email. The client
 * downloads its config spec once (bounded by {@link INIT_TIMEOUT_MS}) and then
 * background-polls its rule set, so `checkGate` is a local evaluation that
 * reflects a flipped gate without a restart. Held for the process lifetime so
 * exposure events keep flushing. Fails closed (`false`) on timeout or any error.
 */
class StatsigFeatureGates implements FeatureGates {
  private readonly statsig: Statsig;
  private readonly log: FeatureFlagLogger;
  private ready: Promise<unknown> | null = null;

  constructor(secretKey: string, log: FeatureFlagLogger) {
    this.statsig = new Statsig(secretKey);
    this.log = log;
  }

  async checkGate(gateName: string, unitId: string, email?: string): Promise<boolean> {
    try {
      if (!this.ready) {
        // `initialize()` RESOLVES a StatsigResult on auth/network failure rather
        // than rejecting (isSuccess=false), so a bare await would treat a failed
        // init as ready. Turn a non-success result into a rejection so it shares
        // the timeout's fail-closed + retry path below.
        const init = withTimeout(this.statsig.initialize(), INIT_TIMEOUT_MS).then((result) => {
          if (!result?.isSuccess) {
            throw new Error(result?.error ?? "Statsig initialize reported failure");
          }
          return result;
        });
        this.ready = init;
        // Never cache a failed init: drop the memo so the next check retries.
        // A transient outage/timeout must not disable the gate until restart.
        // Guard on identity so a later successful init isn't clobbered.
        init.catch(() => {
          if (this.ready === init) this.ready = null;
        });
      }
      await this.ready;
    } catch (err) {
      this.log.warn("feature-flag backend init failed; failing closed", {
        gate: gateName,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }

    try {
      // No per-evaluation log: gates sit on request hot paths, and `unitId` is a
      // stable rollout key we don't want in default logs. Only failures log.
      return this.statsig.checkGate(statsigUser(unitId, email), gateName);
    } catch (err) {
      this.log.warn("feature gate evaluation failed; failing closed", {
        gate: gateName,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Flush pending exposures and stop the client's background work. */
  async shutdown(): Promise<void> {
    try {
      await this.statsig.shutdown();
    } catch (err) {
      this.log.warn("feature-flag backend shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Install Statsig as the process-global feature-flag backend. Returns a disposer
 * that flushes and stops the client; the composition root calls it during
 * graceful shutdown so background refresh/flush work doesn't outlive the process
 * and the boot-time exposures are flushed on exit. The `log` sink receives the
 * backend's fail-closed warnings (see {@link FeatureFlagLogger}).
 */
export function initStatsig(secretKey: string, log: FeatureFlagLogger): () => Promise<void> {
  const backend = new StatsigFeatureGates(secretKey, log);
  setFeatureGates(backend);
  return () => backend.shutdown();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Statsig init timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
