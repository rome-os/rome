import type { Routine } from "./types.js";

/**
 * A TriggerProvider watches for a specific trigger type and calls `fire`
 * when the trigger condition is met.
 */
export interface TriggerProvider {
  readonly type: string;

  /** Start watching for this routine's trigger. Resolves once persistent
   * activation state (e.g. nextRunAt) has been committed. */
  activate(
    routine: Routine,
    fire: (payload: Record<string, unknown>) => Promise<void>,
  ): Promise<void>;

  /** Stop watching for a specific routine. */
  deactivate(routineId: string): void;

  /** Cleanup all watchers. */
  stop(): void;
}
