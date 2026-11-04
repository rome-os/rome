// What the platform said about Rome's own account when the guardian connected
// or fixed it, kept in the account profile cache
// (docs/domains/chats.md#account-profile). The grant's profile goes with its
// connection, and the cache is what still names the account after a
// disconnect.

import type { DrizzleDb, DrizzleTx } from "../../db/index.js";
import type {
  AccountProfile,
  AccountProfilesRepository,
} from "../../db/repositories/account-profiles.js";
import type { GrantAccount } from "../../connections/grant.js";
import type { StoredConnection } from "../../connections/repository.js";
import type { ConnectionDescriptor, ProfileRecord } from "../../connections/types.js";
import { createLogger } from "../../logger.js";

const log = createLogger("account-profiles");

type Descriptors = (connectionKind: string) => ConnectionDescriptor | null | undefined;

/** The account profile a grant's profile states, or null when it states no
 *  name, handle or avatar, or no longer matches the kind's schema. */
function profileOf(
  descriptor: ConnectionDescriptor | null | undefined,
  record: ProfileRecord,
): AccountProfile | null {
  if (!descriptor?.reviveProfile) return null;
  let display: ReturnType<NonNullable<ConnectionDescriptor["reviveProfile"]>>;
  try {
    display = descriptor.reviveProfile(record);
  } catch {
    // A profile that fails its schema names nothing here, and the grant it came
    // with must not fail over a cache.
    return null;
  }
  const profile = {
    displayName: display.displayName ?? null,
    handle: display.handle ?? null,
    avatarUrl: display.avatarUrl ?? null,
  };
  return profile.displayName || profile.handle || profile.avatarUrl ? profile : null;
}

/** Copy the name a grant reports for the account it reaches into the account
 *  profile cache, in the grant's transaction. Never throws. */
export function rememberOwnAccountProfile(
  repo: Pick<AccountProfilesRepository, "fromConnection" | "fillFromConnection">,
  exec: DrizzleDb | DrizzleTx,
  descriptor: ConnectionDescriptor | null | undefined,
  account: GrantAccount | undefined,
  record: ProfileRecord | undefined,
  opts: { onlyIfMissing?: boolean } = {},
): void {
  if (!account || !record) return;
  const profile = profileOf(descriptor, record);
  if (!profile) return;
  const write = opts.onlyIfMissing ? repo.fillFromConnection : repo.fromConnection;
  try {
    write.call(repo, exec, { platform: account.platform, id: account.accountId }, profile);
  } catch (err) {
    log.warn("could not keep a connected account's name in the account profile cache", {
      platform: account.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Copy every held grant's account name into the cache where it holds none,
 *  once at boot, so the accounts connected before the cache learned from
 *  grants keep their name after a disconnect, and a dropped cache is rebuilt.
 *  A name the cache learned since the grant was given is newer, so it stays. */
export function backfillOwnAccountProfiles(
  repo: Pick<AccountProfilesRepository, "fromConnection" | "fillFromConnection">,
  db: DrizzleDb,
  connections: StoredConnection[],
  descriptorOf: Descriptors,
): void {
  for (const connection of connections) {
    rememberOwnAccountProfile(
      repo,
      db,
      descriptorOf(connection.connectionKind),
      connection.grant.account,
      connection.grant.profile,
      { onlyIfMissing: true },
    );
  }
}
