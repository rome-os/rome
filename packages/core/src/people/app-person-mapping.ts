// The `PersonMappingRepository` `@rome-os/app-runtime` publishes to apps,
// answered from People's repository.
//
// The SDK's names are a published contract, so they stay as apps know them:
// `channelMappings` on each person and `addChannelMapping` for a link. This is
// the one place they are translated, so the repository itself speaks People's
// language.

import type { PersonMappingRepository, PersonRecord } from "@rome-os/app-runtime";
import type { PeopleRepository, Person } from "../db/repositories/people.js";

/** What an app reads: the SDK's contract, plus the link key the system app's
 *  send action asks for when it is there. */
export type AppPersonMapping = PersonMappingRepository & {
  linkKeyOf(channel: string): string;
};

function toRecord(person: Person): PersonRecord {
  const { links, ...rest } = person;
  return { ...rest, channelMappings: links };
}

export function appPersonMapping(people: PeopleRepository): AppPersonMapping {
  return {
    async findByChannelUser(channel, channelUserId) {
      const person = await people.byAccount({ channel, channelUserId });
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
    create({ channelMappings, ...person }) {
      return people.create({ ...person, links: channelMappings });
    },
    async addChannelMapping(personId, channel, channelUserId, displayName) {
      return people.linkStated({ channel, channelUserId }, personId, displayName);
    },
    linkKeyOf: (channel) => people.linkKeyOf(channel),
  };
}
