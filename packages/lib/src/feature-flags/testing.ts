import { Statsig } from "@statsig/statsig-node-core";
import { setFeatureGates, resetFeatureGates as resetActiveBackend } from "./index.js";
import { statsigUser } from "./user.js";

/** Control handle for the offline Statsig backend installed by {@link useFakeFeatureGates}. */
export interface FakeFeatureGates {
  /** Make `gateName` pass — for `unitId` only, or for every unit when omitted. */
  enable(gateName: string, unitId?: string): void;
  /** Make `gateName` fail — for `unitId` only, or for every unit when omitted. */
  disable(gateName: string, unitId?: string): void;
  /** Make every gate fail closed, simulating an unreachable/erroring backend. */
  breakBackend(): void;
}

// The active offline instance, tracked so {@link resetFeatureGates} can shut it
// down between tests. Only one is installed at a time.
let activeInstance: Statsig | null = null;

/**
 * Install a **real Statsig client in offline mode** as the process-global
 * feature-flag backend, and return a handle to program it. Unlike a hand-rolled
 * fake, this exercises Statsig's own out-of-the-box test facilities — `new
 * Statsig(key, { disableNetwork: true })` never touches the network, and
 * {@link FakeFeatureGates.enable}/`disable` drive `Statsig.overrideGate` (global
 * when no unit is given, per-unit otherwise) — so tests run against the genuine
 * evaluation engine, not an approximation of it. Gates default to off
 * (fail-closed). Pair with {@link resetFeatureGates} in `afterEach`.
 */
export function useFakeFeatureGates(): FakeFeatureGates {
  // A real (dummy-keyed) client with no network and no event logging: in offline
  // mode every gate resolves purely from the local overrides below, and the
  // client holds no timers/handles, so it neither phones home nor hangs tests.
  const statsig = new Statsig("secret-offline-test-key", {
    disableNetwork: true,
    disableAllLogging: true,
    outputLogLevel: "none",
  });
  const ready = statsig.initialize();
  activeInstance = statsig;
  let broken = false;

  setFeatureGates({
    async checkGate(gateName, unitId, attributes) {
      if (broken) return false;
      await ready;
      return statsig.checkGate(statsigUser(unitId, attributes), gateName);
    },
  });

  return {
    enable(gateName, unitId) {
      statsig.overrideGate(gateName, true, unitId);
    },
    disable(gateName, unitId) {
      statsig.overrideGate(gateName, false, unitId);
    },
    breakBackend() {
      broken = true;
    },
  };
}

/**
 * Restore the default all-off backend and shut down the offline Statsig client
 * installed by {@link useFakeFeatureGates}. Async because the client shutdown
 * flushes and releases the native instance; `await` it in `afterEach` so state
 * never leaks between tests.
 */
export async function resetFeatureGates(): Promise<void> {
  resetActiveBackend();
  const instance = activeInstance;
  activeInstance = null;
  if (instance) {
    try {
      await instance.shutdown();
    } catch {
      // Best-effort: an offline client has nothing to flush, so a shutdown
      // hiccup must never fail a test's teardown.
    }
  }
}
