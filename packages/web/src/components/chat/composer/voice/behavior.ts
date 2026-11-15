import type { StoreApi } from "zustand/vanilla";

/** What every behavior receives: the component's store, and a place to register its cleanup. */
export interface BehaviorContext<State> {
  store: StoreApi<State>;
  onDestroy(cleanup: () => void): void;
}

/**
 * A context for the behaviors of one component. `destroy` runs the cleanups
 * last registered first, so a behavior created later, which may call into an
 * earlier one as it goes, cleans up while the earlier one still works.
 */
export function createBehaviorScope<State>(store: StoreApi<State>) {
  const cleanups: Array<() => void> = [];
  const context: BehaviorContext<State> = {
    store,
    onDestroy: (cleanup) => cleanups.push(cleanup),
  };
  return {
    context,
    destroy() {
      for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    },
  };
}
