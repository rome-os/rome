// Whether an action runs for the team. People's actions read and change what
// the team keeps on people, so a turn for anyone off the team never reaches them.

import { actionExecutionContext } from "../../apps/actions/context.js";
import { type OwnerOfChat, turnWorksForTeam } from "../../apps/actions/who-may-ask.js";

export type { OwnerOfChat } from "../../apps/actions/who-may-ask.js";

/** Whether the running action's turn works for the team, by the rule core's
 * agent tools read with (`turnWorksForTeam`). */
export async function runsForTeam(ownerOfChat: OwnerOfChat): Promise<boolean> {
  return turnWorksForTeam(ownerOfChat, actionExecutionContext.getStore() ?? {});
}
