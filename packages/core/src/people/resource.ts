// Person rows as the contract's `PersonResource`: their accounts named as each
// platform names them, and their activity read across all of them.
//
// Here rather than in the route because every write on this surface answers
// with the person it changed — create, link, unlink, transfer, dismiss, merge —
// so a serializer living in one handler is a serializer the next five copy.

import { readdir } from "node:fs/promises";
import type { Account } from "@rome-os/app-runtime";
import type { AccountSendState, PersonResource } from "@rome/api-types/people";
import type { Message } from "@rome/api-types/message";
import { getRelationshipDir, personProfileFileName, RELATIONSHIP_DIR } from "../profile-memory.js";
import type { AccountNames } from "../channels/account-names.js";
import type { Channels, PlatformOfChannel } from "../channels/channel.js";
import type { MessageAccount } from "../channels/messages.js";
import type { DrizzleDb } from "../db/index.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import type { PeopleRepository } from "../db/repositories/people.js";
import { readActivity } from "./activity.js";
import { readSendStates, sendersOf, type SendDeps } from "./send.js";
import { personMessageStores, timelineAccounts } from "./timeline-sources.js";

export interface PeopleReadDeps extends SendDeps {
  db: DrizzleDb;
  peopleRepo: Pick<PeopleRepository, "all" | "byId">;
  channels: Channels;
  accountNames: Pick<AccountNames, "displayNames">;
  platformOfChannel: PlatformOfChannel;
  /** Rome's own account on a channel, to name a sender by. Absent, no sender
   *  is named. */
  accountOf?: ChannelRecordsRepository["accountOf"];
}

/** A person as the repository reads them: the row and the accounts linked to
 *  it. */
export type PersonRow = Awaited<ReturnType<PeopleRepository["all"]>>[number];

/** Every curated person. */
export async function readPeople(deps: PeopleReadDeps): Promise<PersonResource[]> {
  return serialize(deps, await deps.peopleRepo.all());
}

/** One curated person, or null when the id names none. */
export async function readPerson(deps: PeopleReadDeps, id: string): Promise<PersonResource | null> {
  const person = await findPerson(deps, id);
  return person && (await serialize(deps, [person]))[0];
}

/** The person an id names, as stored — for a caller that needs the links
 *  rather than the resource. */
export async function findPerson(
  deps: Pick<PeopleReadDeps, "peopleRepo">,
  id: string,
): Promise<PersonRow | null> {
  return deps.peopleRepo.byId(id);
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
  // One link is one account on the wire, so a client can address the link it
  // sees. The activity fold is the one place two links of a single account
  // collapse — reporting one person's history twice would be a wrong
  // number, whereas showing both addresses is only what the guardian stored.
  const refs = persons.flatMap((person) => person.links);

  // Independent of each other, and both reach the same channel mirrors: read
  // together, a mirror that folds its whole address book per call serves both
  // from one read of it instead of two.
  const [accountsByPerson, names, sendStates, memoryPaths] = await Promise.all([
    timelineAccounts(
      deps,
      persons.map((person) => person.links),
    ),
    deps.accountNames.displayNames(refs),
    // Whether each link can be written to, asked of the live connections
    // rather than stored: a channel that went down between two reads has to
    // change this answer, and nothing writes a row when it does.
    readSendStates(deps, refs),
    memoryProfilePaths(persons),
  ]);
  const activity = await readActivity(personMessageStores(deps), accountsByPerson);

  // Asked once per platform, since each answer reads the channel records.
  const senders = new Map<string, Account[]>();
  const sendersOn = (platform: string) => {
    let found = senders.get(platform);
    if (!found) {
      found = sendersOf(deps, platform).flatMap((channel) => deps.accountOf?.(channel) ?? []);
      senders.set(platform, found);
    }
    return found;
  };

  let next = 0;
  return persons.map((person, i) => ({
    id: person.id,
    displayName: person.displayName,
    bondLevel: person.bondLevel,
    accounts: person.links.map((link) => {
      const index = next++;
      return {
        channel: link.platform,
        channelUserId: link.id,
        displayName: names[index],
        send: sendStates[index] ?? ("not-connected" as AccountSendState),
        latestAt: latestAtOf(activity.perAccount, accountsByPerson[i], link),
        from: sendersOn(link.platform),
        ...(link.delegate ? { delegate: true as const } : {}),
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
 * When the account behind one link was last active.
 *
 * The activity read is keyed by folded account and this is asked per link,
 * and the two are not the same count: a platform that folds a phone JID and
 * its `@lid` form onto one account answers one head for the two links naming
 * it. So the link is matched by the address the fold put on its account, which
 * is the same rule `timelineAccounts` grouped by.
 */
function latestAtOf(
  heads: Map<MessageAccount, Message>,
  accounts: readonly MessageAccount[] | undefined,
  link: Account,
): number | null {
  // One account is read once per channel it is stored under, so its newest
  // entry is the newest of those reads.
  const latest = (accounts ?? [])
    .filter(
      (candidate) => candidate.channel === link.platform && candidate.addresses.includes(link.id),
    )
    .map((candidate) => heads.get(candidate)?.timestamp ?? null)
    .filter((timestamp) => timestamp !== null);
  return latest.length > 0 ? Math.max(...latest) : null;
}
