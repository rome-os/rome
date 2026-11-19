// The phone book: the guardian's edits to people and accounts, and the
// directory of accounts. Nothing but its routes and the wiring imports it, so
// leaving it out leaves who-is-this and the message path working.
// Vocabulary: docs/domains/people.md.

export {
  type AccountDecision,
  type AccountDecisionDeps,
  type AccountRef,
  dismissAccount,
  restoreAccount,
} from "./account-decisions.js";
export { readAccountDirectory } from "./account-directory.js";
export { createPerson } from "./create.js";
export { deletePerson } from "./delete.js";
export { mergePeople } from "./merge.js";
export { findPerson, readPeople, readPerson } from "./resource.js";
export { updatePerson } from "./update.js";
