// What a link reaches. A link names an account on a platform, and every one of
// Rome's accounts on that platform reaches it, so the person page reads through
// all of them (docs/domains/people.md#account).

import { platformOf } from "@rome/api-types/platform";
import type { StoredAddress } from "../channels/account-fold.js";
import type { Channels } from "../channels/channel.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";

/** The platform the channel `name` is an account on. */
export type PlatformOfChannel = (name: string) => string;

/** Reads a channel's name as its kind of connection, which names the platform
 *  of every kind's first channel. Production passes the channel records. */
const platformOfName: PlatformOfChannel = (name) => platformOf(name);

export interface ReachDeps {
  channels: Channels;
  personMappingRepo: Pick<PersonMappingRepository, "findByChannelUser" | "linkKeyOf">;
  platformOfChannel?: PlatformOfChannel;
  /** Every channel Rome has a record of, connected or not. A disconnected
   *  account's transcript and outbox rows stay readable after a restart drops
   *  it from `channels`. */
  recordedChannels?: () => readonly string[];
}

/** A person and their links, as the repository returns them. */
export interface LinkHolder {
  id: string;
  channelMappings: readonly StoredAddress[];
}

export interface LinkReach {
  /**
   * The link's account at each of Rome's accounts on its platform: the
   * channel the link names first, then the others, live channels before
   * disconnected ones. A link on a platform no other channel is on reaches
   * only itself.
   *
   * Links are still keyed by connection kind, so another person can hold the
   * same id under a second kind on the platform. That address stays theirs and
   * is left out, so one person's page never shows or acts on another's history.
   */
  of(holderId: string, link: StoredAddress): Promise<StoredAddress[]>;
  /** Every one of a person's links' reach, in the links' order. */
  ofAll(person: LinkHolder): Promise<StoredAddress[]>;
  /** Whether two channels are accounts on one platform. */
  samePlatform(a: string, b: string): boolean;
}

/**
 * Reach for one request. The channel list and each channel's platform are read
 * once here rather than once per link. `everyone`, a snapshot of every
 * person's links that a listing already holds, answers who holds an address
 * from memory; without it each candidate address costs one lookup, which is
 * bounded by one person's links.
 */
export function linkReach(deps: ReachDeps, everyone?: readonly LinkHolder[]): LinkReach {
  const platforms = new Map<string, string>();
  const platformOfChannel = (name: string) => {
    let platform = platforms.get(name);
    if (platform === undefined) {
      platform = (deps.platformOfChannel ?? platformOfName)(name);
      platforms.set(name, platform);
    }
    return platform;
  };
  const names = [
    ...new Set([
      ...deps.channels.map((channel) => channel.name),
      ...(deps.recordedChannels?.() ?? []),
    ]),
  ];
  const holderOf = everyone ? snapshotHolders(deps, everyone) : lookupHolder(deps);

  const of = async (holderId: string, link: StoredAddress) => {
    const platform = platformOfChannel(link.channel);
    const reach = [link];
    for (const name of names) {
      if (name === link.channel || platformOfChannel(name) !== platform) continue;
      const holder = await holderOf(name, link.channelUserId);
      if (holder !== null && holder !== holderId) continue;
      reach.push({ channel: name, channelUserId: link.channelUserId });
    }
    return reach;
  };

  return {
    of,
    async ofAll(person) {
      const reaches = await Promise.all(person.channelMappings.map((link) => of(person.id, link)));
      return reaches.flat();
    },
    samePlatform: (a, b) => platformOfChannel(a) === platformOfChannel(b),
  };
}

type HolderOf = (channel: string, channelUserId: string) => Promise<string | null>;

function lookupHolder(deps: ReachDeps): HolderOf {
  return async (channel, channelUserId) =>
    (await deps.personMappingRepo.findByChannelUser(channel, channelUserId))?.id ?? null;
}

/** Who holds each address, from a snapshot of every link. A stored link names
 *  its key, so a channel is read as its key once to look one up. */
function snapshotHolders(deps: ReachDeps, everyone: readonly LinkHolder[]): HolderOf {
  const holders = new Map<string, string>();
  for (const person of everyone) {
    for (const link of person.channelMappings) {
      holders.set(`${link.channel}\0${link.channelUserId}`, person.id);
    }
  }
  const keys = new Map<string, string>();
  return async (channel, channelUserId) => {
    let key = keys.get(channel);
    if (key === undefined) {
      key = deps.personMappingRepo.linkKeyOf(channel);
      keys.set(channel, key);
    }
    return holders.get(`${key}\0${channelUserId}`) ?? null;
  };
}
