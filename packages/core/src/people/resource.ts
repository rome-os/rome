// Person rows as the contract's `PersonResource`: their accounts named as each
// platform names them, and their activity read across all of them.
//
// Here rather than in the route because every write on this surface answers
// with the person it changed — create, link, unlink, transfer, dismiss, merge —
// so a serializer living in one handler is a serializer the next five copy.
//
// The stranger sentinel is a row in the persons table that every dismissed
// account is linked to, not someone the guardian knows. It is excluded here,
// once, so no route can serve it by forgetting to.

import type { PersonResource } from "@rome/api-types/people";
import { STRANGER_PERSON_ID } from "../constants.js";
import type { AccountNames } from "../channels/account-names.js";
import type { Channels } from "../channels/channel.js";
import type { DrizzleDb } from "../db/index.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { readPeopleActivity } from "./activity.js";
import { personMessageStores, timelineAccounts } from "./timeline-sources.js";

export interface PeopleReadDeps {
  db: DrizzleDb;
  personMappingRepo: Pick<PersonMappingRepository, "findAllWithMappings" | "findById">;
  channels: Channels;
  accountNames: Pick<AccountNames, "displayNames">;
}

/** A person as the repository reads them: the row and the accounts linked to
 *  it. */
export type PersonRow = Awaited<ReturnType<PersonMappingRepository["findAllWithMappings"]>>[number];

/** Every curated person. */
export async function readPeople(deps: PeopleReadDeps): Promise<PersonResource[]> {
  const persons = (await deps.personMappingRepo.findAllWithMappings()).filter(
    (person) => person.id !== STRANGER_PERSON_ID,
  );
  return serialize(deps, persons);
}

/** One curated person, or null when the id names none. */
export async function readPerson(deps: PeopleReadDeps, id: string): Promise<PersonResource | null> {
  const person = await findPerson(deps, id);
  return person && (await serialize(deps, [person]))[0];
}

/** The person an id names, as stored — for a caller that needs the mappings
 *  rather than the resource. Null for the sentinel, which is structure. */
export async function findPerson(
  deps: Pick<PeopleReadDeps, "personMappingRepo">,
  id: string,
): Promise<PersonRow | null> {
  return id === STRANGER_PERSON_ID ? null : await deps.personMappingRepo.findById(id);
}

/**
 * Costs the same handful of reads whether it is given one person or every one
 * of them — one address-book read per channel, one display-name read per
 * provider, one summary read per message store — so the listing never grows a
 * per-person query.
 */
async function serialize(
  deps: PeopleReadDeps,
  persons: readonly PersonRow[],
): Promise<PersonResource[]> {
  // One mapping is one account on the wire, so a client can address the link
  // it sees. The activity fold is the one place two mappings of a single
  // account collapse — reporting one person's history twice would be a wrong
  // number, whereas showing both addresses is only what the guardian stored.
  const refs = persons.flatMap((person) => person.channelMappings);

  // Independent of each other, and both reach the same channel mirrors: read
  // together, a mirror that folds its whole address book per call serves both
  // from one read of it instead of two.
  const [accountsByPerson, names] = await Promise.all([
    timelineAccounts(
      deps,
      persons.map((person) => person.channelMappings),
    ),
    deps.accountNames.displayNames(refs),
  ]);
  const activity = await readPeopleActivity(personMessageStores(deps), accountsByPerson);

  let next = 0;
  return persons.map((person, i) => ({
    id: person.id,
    displayName: person.displayName,
    bondLevel: person.bondLevel,
    accounts: person.channelMappings.map((mapping) => ({
      channel: mapping.channel,
      channelUserId: mapping.channelUserId,
      displayName: names[next++],
    })),
    ...activity[i],
  }));
}
