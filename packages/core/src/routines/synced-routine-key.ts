// Keys of the routines core writes from the Concierge's own records: a task's
// schedule, the digest and each follow. Every sync writes what such a routine
// runs and when again from those records, so only a rename sticks.

export const TASK_SCHEDULE_KEY_PREFIX = "concierge-task-schedule:";
export const DIGEST_KEY_PREFIX = "concierge-digest:";
export const FOLLOW_KEY_PREFIX = "concierge-follow:";

/** Whether core keeps the routine with this key in line with the Concierge's records. */
export function isSyncedRoutineKey(key: string | undefined): boolean {
  return (
    key !== undefined &&
    [TASK_SCHEDULE_KEY_PREFIX, DIGEST_KEY_PREFIX, FOLLOW_KEY_PREFIX].some((prefix) =>
      key.startsWith(prefix),
    )
  );
}
