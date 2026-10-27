// The connection's rules, as pure functions over its grant. Nothing here
// touches the store or a live capability. Vocabulary:
// docs/domains/connections.md.

import { domainOf, domainOfGrant, platformOf } from "../channels/platform.js";
import { DifferentAccountError } from "./errors.js";
import type { GrantAccount, GrantValue, PersistedCredential } from "./grant.js";
import type { ConnectionDescriptor, ConnectionId, Credential, ProfileRecord } from "./types.js";

/** Persist a live Credential's envelope. External-custody credentials (function
 *  material) persist as `{ kind: "external" }`, so the store keeps no secret. */
export function toPersisted(cred: Credential): PersistedCredential {
  if (typeof cred.material === "function") {
    return { material: { kind: "external" }, expiresAt: cred.expiresAt };
  }
  return { material: { kind: "inline", record: cred.material }, expiresAt: cred.expiresAt };
}

/** The account `profile` names: the platform and the platform's own id for
 *  it, or undefined when the connection kind names none. `domain` is the
 *  Feishu app's domain, which `platformOf` reads. */
export function accountOf(
  descriptor: ConnectionDescriptor,
  profile: ProfileRecord,
  domain: string | undefined = domainOf(profile),
): GrantAccount | undefined {
  const accountId = descriptor.accountIdOf?.(profile);
  if (!accountId) return undefined;
  return { platform: platformOf(descriptor.connectionKind, domain), accountId };
}

/** The account `record` reaches: the stored one, or the one its profile names
 *  when none was stored, as for a grant the boot pass left without one. A
 *  Feishu grant from before profiles names its domain only in its material. */
export function reachedAccount(
  descriptor: ConnectionDescriptor,
  record: GrantValue,
): GrantAccount | undefined {
  if (record.account) return record.account;
  if (!record.profile) return undefined;
  return accountOf(descriptor, record.profile, domainOfGrant(record));
}

/** The grant a grant leaves: a fresh credential and the profile and
 *  account it names, replacing whatever the connection held. */
export function givenGrant(
  now: Date,
  cred: Credential,
  grantEpoch: string,
  profile?: ProfileRecord,
  account?: GrantAccount,
): GrantValue {
  return {
    state: "authorized",
    credential: toPersisted(cred),
    profile,
    account,
    grantedAt: now,
    grantEpoch,
  };
}

/** The grant a renewal leaves: the same grant on a renewed credential. */
export function renewedGrant(current: GrantValue, cred: Credential, now: Date): GrantValue {
  return {
    ...current,
    state: "authorized",
    credential: toPersisted(cred),
    lastRenewedAt: now,
    degraded: undefined,
  };
}

/** The grant a break leaves: the same grant, marked degraded with why. Its
 *  credential is kept, inert, until a fix replaces it. */
export function brokenGrant(current: GrantValue, reason: string, now: Date): GrantValue {
  return { ...current, state: "degraded", degraded: { at: now, reason } };
}

/** Whether two accounts are the same: the same platform and the platform's
 *  own id. */
export function sameAccount(a: GrantAccount, b: GrantAccount): boolean {
  return a.platform === b.platform && a.accountId === b.accountId;
}

/** Throws DifferentAccountError when `held`, the grant connection `id` holds,
 *  reaches an account and `account`, the one a fix reaches, is another. A
 *  revoked grant reaches none, so it never refuses. */
export function refuseDifferentAccount(
  descriptor: ConnectionDescriptor,
  id: ConnectionId,
  held: GrantValue,
  account: GrantAccount,
): void {
  const reached = reachedAccount(descriptor, held);
  if (reached && !sameAccount(reached, account)) {
    throw new DifferentAccountError(
      descriptor.connectionKind,
      id,
      descriptor.severalAccounts === true,
    );
  }
}
