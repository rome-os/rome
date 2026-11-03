// The `PersonMappingRepository` `@rome-os/app-runtime` publishes to apps,
// answered from People's repository.
//
// The SDK's names are a published contract, so they stay as apps know them:
// `channelMappings` on each person and `addChannelMapping` for a link. This is
// the one place they are translated, so the repository itself speaks People's
// language. An app names an account either as the `Account` value or, as it
// did before accounts, by the channel it heard it on. People names it by the
// platform, so a channel an app passes is read as its platform here.

import type { PersonMappingRepository, PersonRecord } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import type { PlatformOfChannel } from "../channels/channel.js";
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
    create({ channelMappings, accounts, ...person }) {
      return people.create({
        ...person,
        links: [
          ...(channelMappings ?? []).map((mapping) =>
            accountOn(mapping.channel, mapping.channelUserId),
          ),
          ...(accounts ?? []).map(({ platform, id }) => ({ platform, id })),
        ],
      });
    },
    async addChannelMapping(personId, channel, channelUserId) {
      return people.linkStated(accountOn(channel, channelUserId), personId);
    },
    async addAccount(personId, { platform, id }) {
      return people.linkStated({ platform, id }, personId);
    },
  };
}
