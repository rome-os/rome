// What @rome-os/app-runtime 0.11 published for People, kept so an app built
// against it still compiles. Rome no longer has People: the host answers each
// port below with nobody, and refuses every write it refused before. A later
// breaking release deletes this file.

import type { Account } from "./index.js";

/** @deprecated People was removed, so no person has a bond level any more; nothing replaces it. */
export type BondLevel = "guardian" | "inner-circle" | "acquaintance" | "other";

/** @deprecated People was removed, so the host leaves {@link SaidInboundEvent.sender} unset; nothing replaces it. */
export interface SaidSender {
  readonly person: {
    readonly id: string;
    readonly name: string;
    readonly bondLevel: BondLevel;
  } | null;
  readonly delegate: boolean;
  readonly label: string;
}

/** @deprecated People was removed, so no person record holds an account any more; nothing replaces it. */
export interface ChannelMappingRecord {
  channel: string;
  channelUserId: string;
}

/** @deprecated People was removed, so the host answers no person record; nothing replaces it. */
export interface PersonRecord {
  id: string;
  displayName: string;
  bondLevel: BondLevel;
  channelMappings: ChannelMappingRecord[];
  accounts?: Account[];
  profilePath?: string | null;
  approved?: boolean | null;
  createdAt?: Date;
  [key: string]: unknown;
}

/**
 * `deps.people`.
 *
 * @deprecated People was removed; `guardian()` still answers the guardian's
 * accounts, the same as `ctx.access.guardianAccounts()`, which replaces it.
 */
export interface PeopleService {
  guardian(): Promise<{ accounts: Account[] }>;
}

/**
 * `deps.personMappingRepo`.
 *
 * @deprecated People was removed, so every lookup answers nobody (`null` or an
 * empty list) and every write is refused as before; nothing replaces it.
 */
export interface PersonMappingRepository {
  findByChannelUser(channel: string, channelUserId: string): Promise<PersonRecord | null>;
  findByAccount?(account: Account): Promise<PersonRecord | null>;
  findByName(displayName: string): Promise<PersonRecord[]>;
  findByNameFuzzy(displayName: string): Promise<PersonRecord | null>;
  findByBondLevel(bondLevel: BondLevel): Promise<PersonRecord[]>;
  create(data: {
    displayName: string;
    bondLevel: BondLevel;
    profilePath?: string;
    approved?: boolean;
    channelMappings?: { channel: string; channelUserId: string }[];
    accounts?: Account[];
  }): Promise<string>;
  addChannelMapping(
    personId: string,
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): Promise<unknown>;
  addAccount?(personId: string, account: Account): Promise<unknown>;
}

/** @deprecated People was removed; {@link GuardianProfileRepository} still takes this. */
export interface GuardianProfileWrite {
  guardianName?: string;
  agentName?: string;
}

/**
 * `ctx.repositories.guardianProfile`, in the main process only.
 *
 * @deprecated People was removed; `write` still sets the guardian's name and
 * the agent's name through the host's setup path, as before.
 */
export interface GuardianProfileRepository {
  write(input: GuardianProfileWrite): Promise<{ ok: boolean }>;
}

/** @deprecated People was removed; {@link PolicyEngine} still answers this. */
export interface PolicyRule {
  action: "allow" | "block" | "require_approval" | "sentinel_review";
  conditions?: Record<string, unknown>;
}

/** @deprecated People was removed, so `sender` and `bondLevel` match nothing; nothing replaces them. */
export interface PolicyContext {
  channel: string;
  sender: { id: string; bondLevel: string } | null;
  bondLevel: string;
  threadName?: string;
  threadType?: string;
}

/**
 * `deps.policyEngine`.
 *
 * @deprecated People was removed; `evaluate` still answers the guardian's
 * thread, channel and global policies, and `allow` when none matches.
 */
export interface PolicyEngine {
  evaluate(context: PolicyContext): Promise<PolicyRule>;
}
