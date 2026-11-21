// A person's history: their messages across every account, and sending to
// them. It serves the dashboard through http/ over the use cases in
// application/. Vocabulary: docs/domains/people.md.

import type { Action } from "@rome-os/app-runtime";
import type { PersonHistoryDeps } from "./deps.js";
import { personHistoryRoutes } from "./http/index.js";

export {
  asGuardian,
  directPlace,
  readSendStates,
  type SendDeps,
  sendersOf,
} from "./application/send.js";
export { assignAccountHeads, readAccountTimeline } from "./application/timeline.js";
export {
  guardianChannels,
  personMessageStores,
  timelineAccounts,
} from "./application/timeline-sources.js";

export type { PersonHistoryDeps } from "./deps.js";
/** The routes alone, for a test that mounts them beside another feature's. */
export { personHistoryRoutes } from "./http/index.js";
export { respondToSend } from "./http/send-response.js";

/** Person history's two interfaces. Leaving it out is not building this. */
export interface PersonHistory {
  /** Routes for the dashboard and apps, mounted under /api. */
  routes: ReturnType<typeof personHistoryRoutes>;
  /** Actions for agents. None yet: agents send through `system:send_message`. */
  actions: Action[];
}

export function personHistory(deps: PersonHistoryDeps): PersonHistory {
  return { routes: personHistoryRoutes(deps), actions: [] };
}
