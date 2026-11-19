// A person's history: their messages across every account, and sending to
// them. Vocabulary: docs/domains/people.md.

export {
  asGuardian,
  directPlace,
  readSendStates,
  type SendDeps,
  sendersOf,
} from "./send.js";
export { assignAccountHeads, readAccountTimeline } from "./timeline.js";
export { guardianChannels, personMessageStores, timelineAccounts } from "./timeline-sources.js";
