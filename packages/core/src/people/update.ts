// Editing a person: what the guardian calls them, and where they sit on the
// ladder.
//
// Here rather than in the route because which edits are refused is a contract
// decision, not an HTTP one — the same rule the dashboard's mock enforces
// against the same request type. The route turns the answer into a status code.

import { type PersonResource, type UpdatePersonRequest } from "@rome/api-types/people";
import { protectedPersonReason } from "@rome/api-types/persons";
import type { PeopleRepository } from "../db/repositories/people.js";
import { findPerson, readPerson, type PeopleReadDeps } from "./resource.js";

export interface PeopleUpdateDeps extends PeopleReadDeps {
  peopleRepo: PeopleReadDeps["peopleRepo"] & Pick<PeopleRepository, "update">;
}

/** The person as they now read, or why the edit did not happen: `unknown` for
 *  an id naming nobody a caller may address, `refused` for an edit this person
 *  does not accept. */
export type UpdatePersonResult =
  | { person: PersonResource }
  | { unknown: true }
  | { refused: string };

/**
 * Apply an update to a person, leaving every field it does not name alone.
 *
 * The guardian's bond level is fixed: the tier is the top of the ladder and the
 * instance serves exactly one person at it, so moving them down would leave
 * Rome with no guardian while the row that authorizes everything is still
 * theirs. Their name is theirs to change like anyone's.
 *
 * A rename does not re-mint the id. The id is a slug taken at create and every
 * link, profile file and stored reference is written against it, so renaming a
 * person is a change to what they are called and to nothing else.
 */
export async function updatePerson(
  deps: PeopleUpdateDeps,
  id: string,
  update: UpdatePersonRequest,
): Promise<UpdatePersonResult> {
  const person = await findPerson(deps, id);
  if (!person) return { unknown: true };

  if (update.bondLevel !== undefined && protectedPersonReason(person) === "guardian") {
    return { refused: "the guardian's bond level cannot be changed" };
  }

  // An update naming no field is the state the person is already in. Answered
  // with the person rather than written: an empty write is not a statement the
  // repository can make, and there is nothing here to make it about.
  if (Object.keys(update).length > 0) {
    await deps.peopleRepo.update(id, update);
  }

  const updated = await readPerson(deps, id);
  if (!updated) throw new Error(`person ${id} does not read back after an update`);
  return { person: updated };
}
