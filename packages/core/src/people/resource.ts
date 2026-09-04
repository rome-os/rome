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

import { readdir } from "node:fs/promises";
import type { AccountSendState, PersonResource, TimelineEntry } from "@rome/api-types/people";
import { STRANGER_PERSON_ID } from "../constants.js";
import { getRelationshipDir, personProfileFileName, RELATIONSHIP_DIR } from "../profile-memory.js";
import type { AccountNames } from "../channels/account-names.js";
import type { Channels } from "../channels/channel.js";
import type { MessageAccount } from "../channels/messages.js";
import type { DrizzleDb } from "../db/index.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import { readActivity } from "./activity.js";
import { readSendStates, type SendDeps } from "./send.js";
import { personMessageStores, timelineAccounts } from "./timeline-sources.js";

export interface PeopleReadDeps extends SendDeps {
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
  const [accountsByPerson, names, sendStates, memoryPaths] = await Promise.all([
    timelineAccounts(
      deps,
      persons.map((person) => person.channelMappings),
    ),
    deps.accountNames.displayNames(refs),
    // Whether each mapping can be written to, asked of the live connections
    // rather than stored: a channel that went down between two reads has to
    // change this answer, and nothing writes a row when it does.
    readSendStates(deps, refs),
    memoryProfilePaths(persons),
  ]);
  const activity = await readActivity(personMessageStores(deps), accountsByPerson);

  let next = 0;
  return persons.map((person, i) => ({
    id: person.id,
    displayName: person.displayName,
    bondLevel: person.bondLevel,
    accounts: person.channelMappings.map((mapping) => {
      const index = next++;
      return {
        channel: mapping.channel,
        channelUserId: mapping.channelUserId,
        displayName: names[index],
        send: sendStates[index] ?? ("not-connected" as AccountSendState),
        latestAt: latestAtOf(activity.perAccount, accountsByPerson[i], mapping),
      };
    }),
    memoryPath: memoryPaths[i],
    ...activity.perPerson[i],
  }));
}

/**
 * The profile written about each of these people, in the order given — the path
 * where one exists, null where none does.
 *
 * One read of the relationship directory answers the whole listing, so this
 * costs the same whether it is given one person or every one of them, like the
 * reads above it.
 *
 * A profile is named either way it can be: by the path stored on the row, which
 * is how the guardian's is addressed, and otherwise by the person's id. Both
 * name a file in this one directory — a stored path pointing anywhere else is
 * not honored, because the dashboard opens what this answers under the memory
 * root and a path from outside it would be a link the file browser cannot
 * resolve.
 *
 * Answered only for a file that is there. Creating a person writes no profile —
 * the agent writes one when it has something to remember — so a path served for
 * a file nobody wrote is a link to nothing.
 */
async function memoryProfilePaths(persons: readonly PersonRow[]): Promise<(string | null)[]> {
  const written = new Set(await readdir(getRelationshipDir()).catch(() => []));

  return persons.map((person) => {
    const stored = person.profilePath?.startsWith(`${RELATIONSHIP_DIR}/`)
      ? person.profilePath.slice(RELATIONSHIP_DIR.length + 1)
      : null;
    const fileName = stored ?? personProfileFileName(person.id);
    return written.has(fileName) ? `${RELATIONSHIP_DIR}/${fileName}` : null;
  });
}

/**
 * When the account behind one mapping was last active.
 *
 * The activity read is keyed by folded account and this is asked per mapping,
 * and the two are not the same count: a channel that folds a phone JID and its
 * `@lid` form onto one account answers one head for the two links naming it.
 * So the mapping is matched by the address the fold put on its account, which
 * is the same rule `timelineAccounts` grouped by.
 */
function latestAtOf(
  heads: Map<MessageAccount, TimelineEntry>,
  accounts: readonly MessageAccount[] | undefined,
  mapping: { channel: string; channelUserId: string },
): number | null {
  const account = accounts?.find(
    (candidate) =>
      candidate.channel === mapping.channel && candidate.addresses.includes(mapping.channelUserId),
  );
  return (account && heads.get(account)?.timestamp) ?? null;
}
