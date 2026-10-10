import type { RomeAppContext } from "@rome-os/app-runtime";

export const DAILY_DREAM_ROUTINE_NAME = "daily-dream";
const REVIEW_LOCAL_TIME = "03:00";
const REVIEW_TZID = "UTC";
const DAILY_RRULE = "FREQ=DAILY";

/**
 * Creates the `daily-dream` routine unless a routine with that name exists,
 * enabled or not. Safe to call on every start. Returns whether it created
 * one. Throws when `create_routine` rejects the routine.
 */
export async function ensureDailyDreamRoutine(
  appContext: Pick<RomeAppContext, "listRoutines" | "runAction">,
): Promise<"created" | "exists"> {
  // Dedup on the name alone. Matching on actionName too would let an
  // unrelated routine that runs `dream` suppress this one.
  const routines = await appContext.listRoutines();
  if (routines.some((routine) => routine.name === DAILY_DREAM_ROUTINE_NAME)) {
    return "exists";
  }

  // The runtime stamps the calling app as the routine's manager, so a guardian
  // cannot delete it.
  const result = await appContext.runAction("create_routine", {
    name: DAILY_DREAM_ROUTINE_NAME,
    trigger: {
      type: "schedule",
      tzid: REVIEW_TZID,
      // Floating: the review runs at 03:00 in the guardian's timezone and
      // follows them when it changes. The tzid only seeds the binding.
      tzMode: "floating",
      localTime: REVIEW_LOCAL_TIME,
      rrule: DAILY_RRULE,
    },
    actionName: "dream",
    args: {},
  });
  // create_routine reports caller-fixable problems as { status: "error" }
  // instead of throwing.
  if (result.status === "error") {
    throw new Error(`create_routine failed: ${result.error}`);
  }
  return "created";
}
