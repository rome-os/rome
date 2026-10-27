// What every platform calls its accounts, behind one call. `Accounts`
// (accounts.ts) is one channel's address book; this is the display-name half of
// all of them folded together, so a caller holding an `Account` — the platform
// and the platform's own id for it (docs/domains/chats.md#account) — never
// learns which address book answers for which platform, nor that some
// platforms have none at all.

import type { Account } from "@rome-os/app-runtime";
import { platformOf } from "@rome/api-types/platform";
import type { SentinelLogRepository } from "../db/repositories/sentinel-log.js";
import type { AccountProfiles } from "./account-profiles.js";
import type { Accounts } from "./accounts.js";
import { addressBooks, type Channels, type PlatformOfChannel } from "./channel.js";

/**
 * What to call an account, on any channel.
 *
 * A channel joins by implementing `Accounts`, which is what a channel that
 * mirrors an address book owes anyway. A channel Rome only ever sees senders on
 * implements nothing and falls through to the names those senders sent.
 */
export class AccountNames {
  constructor(
    /** Address books by platform. */
    private readonly providers: Readonly<Record<string, Pick<Accounts, "resolve">>>,
    private readonly senderNames: Pick<SentinelLogRepository, "listLatestDisplayNames">,
    private readonly profiles?: Pick<AccountProfiles, "displayNames">,
  ) {}

  /**
   * The name its platform holds, then the name the account profile cache
   * learned for it, then the name its sender put on a message, then the
   * identifier itself — never an empty string, so a caller always has
   * something to render.
   *
   * A channel that addresses one account several ways answers its platform's
   * name to every one of them. Neither fallback can: a sender's own name is
   * filed under the address its message arrived on, and the last resort only
   * echoes what it was asked. A caller that folds addresses itself asks with
   * the account's own address.
   */
  async displayName(account: Account): Promise<string> {
    const [name] = await this.displayNames([account]);
    return name;
  }

  /**
   * The same answers for a listing, positionally — one name per account, in the
   * order asked.
   *
   * This is the call a directory read wants. Every mirror is asked at once, so
   * a channel that answers from a read of its whole address book serves the
   * page from one such read rather than one per row, and the sentinel log is
   * read once, and only where a mirror left a name unanswered. The profile
   * cache is read the same way, before the sentinel log.
   */
  async displayNames(accounts: readonly Account[]) {
    const mirrored = await Promise.all(
      accounts.map((account) => this.providers[account.platform]?.resolve(account.id) ?? null),
    );
    let names = mirrored.map((account) => named(account?.name));
    if (names.every((name) => name != null)) return names as string[];

    if (this.profiles) {
      const unanswered = accounts.filter((_, i) => names[i] == null);
      const learned = await this.profiles.displayNames(unanswered);
      let next = 0;
      names = names.map((name) => name ?? learned[next++]);
      if (names.every((name) => name != null)) return names as string[];
    }

    const sent = await this.readSenderNames();
    return names.map((name, i) => name ?? sent.get(key(accounts[i])) ?? accounts[i].id);
  }

  /** The name each sender last put on a message, by account. */
  private async readSenderNames(): Promise<Map<string, string>> {
    const senderNames = new Map<string, string>();
    for (const row of await this.senderNames.listLatestDisplayNames()) {
      const name = named(row.displayName);
      if (name) senderNames.set(key(row.account), name);
    }
    return senderNames;
  }
}

/** A provider joins the directory by taking an entry in the channel list
 *  (channel-list.ts), and every caller keeps asking the same one question. */
export function createAccountNames(deps: {
  channels: Channels;
  sentinelLogRepo: SentinelLogRepository;
  platformOfChannel?: PlatformOfChannel;
  profiles?: Pick<AccountProfiles, "displayNames">;
}): AccountNames {
  return new AccountNames(
    addressBooks(deps.channels, deps.platformOfChannel ?? platformOf),
    deps.sentinelLogRepo,
    deps.profiles,
  );
}

const key = (account: Account) => `${account.platform}\n${account.id}`;

/** A name, or null where there is only blank space. A stored empty string is a
 *  platform holding no name, not a name that renders as nothing. */
function named(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
