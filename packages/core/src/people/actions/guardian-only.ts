// Whether an action runs for the guardian. People's actions read and change
// what the guardian keeps on people, so a visitor's turn never reaches them.

import { actionExecutionContext } from "../../apps/actions/context.js";
import { type OwnerOfChat, turnWorksForGuardian } from "../../apps/actions/who-may-ask.js";

export type { OwnerOfChat } from "../../apps/actions/who-may-ask.js";

/** Whether the running action's turn works for the guardian, by the rule core's
 * agent tools read with (`turnWorksForGuardian`). */
export async function runsForGuardian(ownerOfChat: OwnerOfChat): Promise<boolean> {
  return turnWorksForGuardian(ownerOfChat, actionExecutionContext.getStore() ?? {});
}
