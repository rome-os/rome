// Deleting a person: their links go, so each of their accounts is a stranger
// again, and every chat keeps its history (docs/domains/people.md#person).
//
// Here rather than in the route for the same reason merge is: which deletes are
// refused is a contract decision, not an HTTP one. The transaction is the
// person repository's; this turns the reason it gives back into the sentence a
// caller reads.
//
// What a delete does NOT touch, as with merge: the person's profile file in the
// relationship directory. A filesystem write cannot join the transaction the
// links go in, and the file is the guardian's prose to keep or remove in Memory.

import type { PeopleRepository } from "../db/repositories/people.js";

export interface PeopleDeleteDeps {
  peopleRepo: Pick<PeopleRepository, "delete">;
}

/** Whether the person is gone, or why not: `unknown` for an id that names
 *  nobody, and `refused` for the guardian, who stays. */
export type DeletePersonResult = { deleted: true } | { unknown: true } | { refused: string };

export async function deletePerson(
  deps: PeopleDeleteDeps,
  personId: string,
): Promise<DeletePersonResult> {
  const result = await deps.peopleRepo.delete(personId);
  if (result.deleted) return { deleted: true };
  return result.reason === "unknown"
    ? { unknown: true }
    : { refused: "the guardian cannot be deleted" };
}
