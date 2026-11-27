// A person's history: their messages across every account, and whether each
// account can be sent to. The rules are in application/ and
// chats/direct-place.ts; the chat composer's people listing reads them.
// Vocabulary: docs/domains/people.md.

export {
  asGuardian,
  readSendStates,
  type SendDeps,
  sendersOf,
} from "../../chats/direct-place.js";
export { assignAccountHeads, readAccountTimeline } from "./application/timeline.js";
export {
  guardianChannels,
  personMessageStores,
  timelineAccounts,
} from "./application/timeline-sources.js";
