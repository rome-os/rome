// The `PersonMappingRepository` `@rome-os/app-runtime` publishes to apps,
// answered from People's repository.
//
// The SDK's names are a published contract, so they stay as apps know them:
// `channelMappings` on each person, and `addChannelMapping`, which is refused
// with every other way an app could make a link. This is
// the one place they are translated, so the repository itself speaks People's
// language. An app names an account either as the `Account` value or, as it
// did before accounts, by the channel it heard it on. People names it by the
// platform, so a channel an app passes is read as its platform here.

import type { PersonMappingRepository, PersonRecord } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import type { PlatformOfChannel } from "../chats/connected-accounts/connected-account.js";
import type { PeopleRepository, Person } from "../db/repositories/people.js";

function toRecord(person: Person): PersonRecord {
  const { links, ...rest } = person;
  // The SDK's mapping is the account and nothing else, so the delegate mark
  // stays People's until the SDK publishes it.
  const accounts = links.map(({ platform, id }) => ({ platform, id }));
  return {
    ...rest,
    channelMappings: accounts.map(({ platform, id }) => ({ channel: platform, channelUserId: id })),
    accounts,
  };
}

/** Only the guardian links an account to a person (docs/domains/people.md#link),
 *  so an app's request for one is refused rather than recorded. The SDK keeps
 *  the methods so apps built against it still compile. */
function refuseLink(): never {
  throw new Error("Apps cannot link accounts to persons. Only the guardian links an account.");
}

/** `platformOfChannel` reads a channel an app names as its platform. Absent,
 *  the platform of the connection kind a channel is named after. */
export function appPersonMapping(
  people: PeopleRepository,
  platformOfChannel: PlatformOfChannel = platformOf,
): PersonMappingRepository {
  const accountOn = (channel: string, channelUserId: string) => ({
    platform: platformOfChannel(channel),
    id: channelUserId,
  });
  return {
    async findByChannelUser(channel, channelUserId) {
      const person = await people.byAccount(accountOn(channel, channelUserId));
      return person && toRecord(person);
    },
    async findByName(displayName) {
      return (await people.byName(displayName)).map(toRecord);
    },
    async findByNameFuzzy(displayName) {
      const person = await people.byNameIgnoringCase(displayName);
      return person && toRecord(person);
    },
    async findByBondLevel(bondLevel) {
      return (await people.byBondLevel(bondLevel)).map(toRecord);
    },
    async findByAccount({ platform, id }) {
      const person = await people.byAccount({ platform, id });
      return person && toRecord(person);
    },
    async create({ channelMappings, accounts, ...person }) {
      if ((channelMappings?.length ?? 0) + (accounts?.length ?? 0) > 0) refuseLink();
      return people.create({ ...person, links: [] });
    },
    async addChannelMapping() {
      refuseLink();
    },
    async addAccount() {
      refuseLink();
    },
  };
}
