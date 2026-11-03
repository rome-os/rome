import type { RomeAppContext, Routine } from "@rome-os/app-runtime";

export const DREAM_ROUTINE_NAME = "dream";
/** The name the routine had while it ran every day. */
export const LEGACY_DREAM_ROUTINE_NAME = "daily-dream";
/** Hours of history one dream reviews: one 72-hour interval plus two, so the extra
 *  hour of a fall-back DST change still leaves no chat between two dreams. */
export const DREAM_WINDOW_HOURS = 74;
const REVIEW_LOCAL_TIME = "03:00";
const REVIEW_TZID = "UTC";
// The scheduler runs this as day-of-month */3 (1, 4, 7, ...), so the gap across
// a month end is one to three days and never longer than the window.
const DREAM_RRULE = "FREQ=DAILY;INTERVAL=3";

/** The routine that schedules dreams, preferring the current one over a daily one not yet replaced. */
export function findDreamRoutine(routines: Routine[]): Routine | undefined {
  return (
    routines.find((routine) => routine.name === DREAM_ROUTINE_NAME) ??
    routines.find((routine) => routine.name === LEGACY_DREAM_ROUTINE_NAME)
  );
}

/**
 * Creates the `dream` routine unless one with that name exists, enabled or
 * not, and replaces an enabled `daily-dream` routine with it. A disabled
 * `daily-dream` is the guardian's off switch, so it is left alone and no
 * `dream` routine is created. Safe to call on every start. Throws when
 * `create_routine` rejects the routine. A daily routine that cannot be deleted
 * yet stays until the next start.
 */
export async function ensureDreamRoutine(
  appContext: Pick<RomeAppContext, "listRoutines" | "runAction">,
): Promise<"created" | "replaced" | "exists"> {
  // Dedup on the name alone. Matching on actionName too would let an
  // unrelated routine that runs `dream` suppress this one.
  const routines = await appContext.listRoutines();
  const current = routines.find((routine) => routine.name === DREAM_ROUTINE_NAME);
  const legacy = routines.find((routine) => routine.name === LEGACY_DREAM_ROUTINE_NAME);
  if (!current && legacy && !legacy.enabled) return "exists";

  if (!current) {
    // The runtime stamps the calling app as the routine's manager, so a
    // guardian cannot delete it.
    const result = await appContext.runAction("create_routine", {
      name: DREAM_ROUTINE_NAME,
      trigger: {
        type: "schedule",
        tzid: REVIEW_TZID,
        // Floating: the review runs at 03:00 in the guardian's timezone and
        // follows them when it changes. The tzid only seeds the binding.
        tzMode: "floating",
        localTime: REVIEW_LOCAL_TIME,
        rrule: DREAM_RRULE,
      },
      actionName: "dream",
      // The action defaults to DREAM_WINDOW_HOURS, so the constant stays the
      // one source of truth for routines already installed.
      args: {},
    });
    // create_routine reports caller-fixable problems as { status: "error" }
    // instead of throwing.
    if (result.status === "error") {
      throw new Error(`create_routine failed: ${result.error}`);
    }
  }
  if (!legacy) return current ? "exists" : "created";

  // Created before deleted, so a failed delete leaves dreams scheduled twice
  // rather than not at all.
  const removed = await appContext.runAction("delete_routine", { routineId: legacy.id });
  if (removed.status === "error") {
    throw new Error(`delete_routine failed for ${LEGACY_DREAM_ROUTINE_NAME}: ${removed.error}`);
  }
  return "replaced";
}
