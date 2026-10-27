// Creating a person, with the accounts the guardian says are theirs.
//
// Here rather than in the route because the outcome is a contract decision,
// not an HTTP one: either the person exists with every account named, or
// nothing was written and one of those accounts belongs to someone else. The
// route turns that answer into a status code and holds no rule of its own.

import {
  linkConflict,
  type LinkConflict,
  type NewPerson,
  type PersonResource,
} from "@rome/api-types/people";
import { AccountHeldError, type PeopleRepository } from "../db/repositories/people.js";
import { readPerson, type PeopleReadDeps } from "./resource.js";

export interface PeopleWriteDeps extends PeopleReadDeps {
  peopleRepo: PeopleReadDeps["peopleRepo"] & Pick<PeopleRepository, "create">;
}

/** The person that now exists, or the account that stopped them existing. */
export type CreatePersonResult = { person: PersonResource } | { conflict: LinkConflict };

/**
 * Create a person and link every account named, or write nothing at all.
 *
 * Both-or-neither because the halves are worthless apart. A person with none
 * of their accounts is unreachable — no inbound message resolves to them —
 * and their name is now taken, so the retry that would repair them reads as a
 * duplicate instead. An account linked to a person who was never committed is
 * a link to nobody.
 *
 * A dismissed account links silently. Dismissal files an account under the
 * stranger sentinel, so a guardian naming its sender is telling Rome who that
 * sender is, which is the answer dismissal declined to give rather than one it
 * contradicts.
 */
export async function createPerson(
  deps: PeopleWriteDeps,
  request: NewPerson,
): Promise<CreatePersonResult> {
  let id: string;
  try {
    id = await deps.peopleRepo.create({
      displayName: request.displayName,
      bondLevel: request.bondLevel,
      // The guardian typed this person in, so there is nobody left to approve
      // them — the same standing every person the dashboard creates has.
      approved: true,
      links: request.accounts,
    });
  } catch (err) {
    if (err instanceof AccountHeldError) {
      const { holder } = err;
      return {
        conflict: linkConflict(holder, { id: holder.personId, displayName: holder.personName }),
      };
    }
    throw err;
  }

  const person = await readPerson(deps, id);
  if (!person) throw new Error(`created person ${id} does not read back`);
  return { person };
}
