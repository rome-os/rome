// The patrol's pre-check: whether anything new came in since the last patrol,
// decided by code from counts, with no model. Most runs end here.
// docs/architecture/concierge-patrol.md#pre-check

/** What changed since the last patrol, as counts Rome holds. */
export interface PatrolSignals {
  /** The patrol never ran past its pre-check. */
  firstRun: boolean;
  /** A wake-up the patrol set itself came due. */
  recheck: boolean;
  /** Messages the owner wrote in the main chat since the last patrol. */
  ownerMessages: number;
  /** Tasks whose row changed, or that ended, since the last patrol. */
  tasksChanged: number;
  /** Tasks whose wait on the owner reached {@link LONG_WAIT_MS} since the last patrol. */
  tasksWaitingLong: number;
  /** Memory files the patrol reads that changed since the last patrol. */
  memoryChanged: boolean;
  /** Calendar events that came within the next day since the last patrol, or changed since it. */
  calendarSoon: number;
  /** Open observations whose due time came within the next day since the last patrol. */
  observationsDue: number;
}

/** A wait on the owner this long is a state change worth a look. */
export const LONG_WAIT_MS = 2 * 24 * 60 * 60_000;

export const NO_SIGNALS: PatrolSignals = {
  firstRun: false,
  recheck: false,
  ownerMessages: 0,
  tasksChanged: 0,
  tasksWaitingLong: 0,
  memoryChanged: false,
  calendarSoon: 0,
  observationsDue: 0,
};

/** Whether the patrol reads further, and the signals that made it. */
export function precheck(signals: PatrolSignals): { run: boolean; reasons: string[] } {
  const reasons = [
    signals.firstRun && "first_run",
    signals.recheck && "recheck",
    signals.ownerMessages > 0 && `owner_messages:${signals.ownerMessages}`,
    signals.tasksChanged > 0 && `tasks_changed:${signals.tasksChanged}`,
    signals.tasksWaitingLong > 0 && `tasks_waiting_long:${signals.tasksWaitingLong}`,
    signals.memoryChanged && "memory_changed",
    signals.calendarSoon > 0 && `calendar_soon:${signals.calendarSoon}`,
    signals.observationsDue > 0 && `observations_due:${signals.observationsDue}`,
  ].filter((reason): reason is string => typeof reason === "string");
  return { run: reasons.length > 0, reasons };
}

/** Whether `at` lies in the window (`since`, `until`]. A null `since` takes everything up to `until`. */
export const inWindow = (at: number, since: number | null, until: number) =>
  at <= until && (since === null || at > since);
