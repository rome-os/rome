// What each platform says about the accounts Rome meets: the account profile
// cache (docs/domains/chats.md#account-profile). The channels fill it as they
// learn, from an address book's sync and from the messages senders send, and
// every read is keyed by the `Account` value, the platform and its own id.
//
// It is a read model. A channel's own mirror stays the source for what it
// mirrors, so `AccountNames` (account-names.ts) asks the mirror first and this
// cache after it.

import type { Account, ChannelMessage } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import type { AccountProfilesRepository } from "../db/repositories/account-profiles.js";
import type { ChannelRecordsRepository } from "../db/repositories/channel-records.js";
import { createLogger } from "../logger.js";
import type { Accounts } from "./accounts.js";

const log = createLogger("account-profiles");

/** Large enough that an address book arrives as one page. */
const WHOLE_BOOK = Number.MAX_SAFE_INTEGER;

export class AccountProfiles {
  /** The platforms whose address book is being copied now, and whether a sync
   *  landed during the copy, so one more copy follows it. */
  private readonly copying = new Map<string, { again: boolean }>();
  /** The platforms an address book fills. Their ids are the book's own, so a
   *  message's sender address, which may be another of the account's aliases,
   *  never keys a row there. */
  private readonly booked = new Set<string>();

  constructor(
    private readonly repo: Pick<
      AccountProfilesRepository,
      "fromAddressBook" | "fromMessage" | "profilesOf"
    >,
    /** The platform a channel's accounts live on. A link and a sentinel row
     *  still name an account by its channel, so a read by either translates. */
    private readonly platformOfChannel: (channel: string) => string,
  ) {}

  /**
   * Copy `book` into the cache as `platform`'s address book holds it now.
   * Called after each sync that can change a name, and once at boot so a cache
   * that was dropped is rebuilt. Syncs arrive in bursts, so a call during a
   * copy asks for one more copy after it rather than a copy of its own.
   */
  refresh(platform: string, book: Pick<Accounts, "listAccounts">): void {
    this.booked.add(platform);
    const running = this.copying.get(platform);
    if (running) {
      running.again = true;
      return;
    }
    const state = { again: false };
    this.copying.set(platform, state);
    void (async () => {
      try {
        do {
          state.again = false;
          await this.copy(platform, book);
        } while (state.again);
      } catch (err) {
        log.warn("could not copy an address book into the account profile cache", {
          platform,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.copying.delete(platform);
      }
    })();
  }

  /**
   * Learn what an inbound message's sender called themselves. The sender is on
   * the platform of the account the message arrived on, or of its channel
   * where Rome does not know that account. A platform an address book fills
   * learns nothing from messages: a sender's address there may be an alias of
   * an account the book keys by another, and the book already holds the name.
   * Never throws: a profile is a cache, and failing to fill it must not hold
   * up the message.
   */
  heard(
    message: Pick<
      ChannelMessage,
      "channel" | "account" | "direction" | "senderId" | "senderDisplayName" | "senderUsername"
    >,
  ): void {
    if (message.direction !== "inbound" || !message.senderId) return;
    const displayName = notAnId(named(message.senderDisplayName), message.senderId);
    const handle = named(message.senderUsername);
    if (!displayName && !handle) return;
    const platform = message.account?.platform ?? this.platformOfChannel(message.channel);
    if (this.booked.has(platform)) return;
    this.repo
      .fromMessage({ platform, id: message.senderId }, { displayName, handle, avatarUrl: null })
      .catch((err) => {
        log.warn("could not record a sender's profile", {
          platform,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /** The display name the cache holds for each address, positionally, or null. */
  async displayNames(
    addresses: Array<{ channel: string; channelUserId: string }>,
  ): Promise<Array<string | null>> {
    // A listing names a handful of channels across many rows, and each
    // translation can read the channel records, so each channel is read once.
    const platforms = new Map<string, string>();
    const platformOf = (channel: string) => {
      let platform = platforms.get(channel);
      if (platform === undefined) {
        platform = this.platformOfChannel(channel);
        platforms.set(channel, platform);
      }
      return platform;
    };
    const profiles = await this.repo.profilesOf(
      addresses.map((address) => ({
        platform: platformOf(address.channel),
        id: address.channelUserId,
      })),
    );
    return profiles.map((profile) => named(profile?.displayName));
  }

  private async copy(platform: string, book: Pick<Accounts, "listAccounts">): Promise<void> {
    const { accounts } = await book.listAccounts({ limit: WHOLE_BOOK });
    await this.repo.fromAddressBook(
      accounts.map((account) => ({
        account: { platform, id: account.id } satisfies Account,
        displayName: named(account.name),
        handle: named(account.identifiers.username),
        avatarUrl: null,
      })),
    );
  }
}

/**
 * The platform a channel's accounts live on, for a name a stored row holds.
 *
 * A row may name a channel by its id, or, as a person's link does, by the
 * connection kind it was made on. A second Feishu app's channel has an opaque
 * id and its links say `feishu`, so a name reads the platform of the one
 * channel it reaches now, before any record that merely carries the name: a
 * `feishu` row left by a disconnected Feishu app must not outvote the Lark app
 * the link reaches. A channel id reaches its own channel. Only where a name
 * reaches no one channel does a record of that name answer, and then the
 * connection kind's own platform, which cannot tell Lark from Feishu.
 */
export function channelPlatforms(
  records: Pick<ChannelRecordsRepository, "platformOf" | "channelOfLink">,
): (channel: string) => string {
  return (channel) => {
    const reached = records.channelOfLink(channel);
    return (
      (reached ? records.platformOf(reached) : null) ??
      records.platformOf(channel) ??
      platformOf(channel)
    );
  };
}

/**
 * `sink`, with `refresh` called after each of the `writes` it completes.
 *
 * An address book's sync writes its mirror through a sink. Wrapping the sink
 * is how the cache hears a sync landed without the channel that syncs knowing
 * the cache exists.
 */
export function refreshingAfter<S extends object>(
  sink: S,
  writes: ReadonlyArray<keyof S & string>,
  refresh: () => void,
): S {
  const watched = new Set<string | symbol>(writes);
  return new Proxy(sink, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (!watched.has(property)) return value.bind(target);
      return async (...args: unknown[]) => {
        const result = await value.apply(target, args);
        refresh();
        return result;
      };
    },
  });
}

/**
 * A name, or null where it only echoes the sender's id. Some channels label a
 * nameless sender with its id, or the part of it a person would read: an email
 * address for an `unauthenticated:` sender, a WeChat id before its `@`.
 */
function notAnId(name: string | null, senderId: string): string | null {
  if (!name) return null;
  const echoes =
    name === senderId || senderId.startsWith(`${name}@`) || senderId.endsWith(`:${name}`);
  return echoes ? null : name;
}

/** A value, or null where there is only blank space. */
function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
