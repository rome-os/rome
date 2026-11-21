// LinkedIn: the guardian's signed-in LinkedIn, through Rome's server-side
// browser. Nothing in Connections imports it, so leaving it out of the wiring
// leaves every other kind working. Vocabulary: docs/domains/connections.md.

import type { KindMount } from "../../kind-mount.js";
import { createLinkedInDescriptor, type LinkedInDescriptorDeps } from "./descriptor.js";

export type { LinkedInDescriptorDeps } from "./descriptor.js";
export {
  linkedInMemberIdFromProfileUrl,
  type LinkedInHistoryMessage,
  type LinkedInMessageInput,
  type LinkedInParticipantInput,
  type LinkedInParticipantProfileSyncState,
  type LinkedInParticipantRow,
  type LinkedInReplyTarget,
  type LinkedInSyncSink,
  type LinkedInThreadCursor,
  type LinkedInThreadInput,
  type LinkedInThreadParticipantInput,
} from "./linkedin-sync.js";

export function linkedin(deps: LinkedInDescriptorDeps): KindMount {
  return { descriptor: createLinkedInDescriptor(deps) };
}
