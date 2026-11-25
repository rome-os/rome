// The link code's shape. Discord's inbound text reads a code-shaped message as
// a bare command, so the check stays while that adapter imports it.
// Vocabulary: docs/domains/people.md.

export { isLinkCodeMessage } from "./application/guardian-link-code.js";
