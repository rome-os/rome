// A person's history: their messages across every account, and sending to
// them. The rules are in application/; the chat composer's people listing and
// the assistants' routes read them. Vocabulary: docs/domains/people.md.

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

export { respondToSend } from "./http/send-response.js";
