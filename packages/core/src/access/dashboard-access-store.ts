import type { DrizzleDb } from "../db/index.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  inOneTransaction,
  invitedEmailsSaved,
  type MemberContext,
  memberContext,
  memberEmails,
  roleOfAccount,
} from "./application/members.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  readDashboardAccessRevision,
  type DashboardAccessConfig,
} from "./dashboard-access-config.js";
import { normalizeVisitorEmail } from "./visitor-email.js";

/** The dashboard allow-list as Rome Cloud receives it, with the revision it was saved under. */
export interface VisitorAllowList {
  emails: readonly string[];
  revision: number;
}

/**
 * Saves the invited emails to the members, and owns the settings record that
 * keeps the list's revision and the Rome Cloud account each member's email
 * last signed in as a visitor with. The members are the one source of which
 * emails are on the list. The record's own copy of the list stays as an older
 * build wrote it, for a rollback, and is never read. Every write runs one at a
 * time, so each save gets its own revision and a raise or a sign-in never
 * loses a save.
 *
 * The record replaces an older one keyed by email alone, which missed an email
 * signing in with a new account. That record is dropped on the next write, so
 * each listed visitor's next sign-in counts as a new account once.
 */
export class DashboardAccessStore {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly members: MemberContext;

  constructor(
    private readonly settingsRepo: Pick<SettingsRepository, "get" | "set">,
    private readonly db: DrizzleDb,
  ) {
    this.members = memberContext(db);
  }

  async read(): Promise<VisitorAllowList> {
    const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
    return {
      emails: await memberEmails(this.members),
      revision: readDashboardAccessRevision(stored),
    };
  }

  /**
   * Makes the members the persons behind the config's emails, then stores the
   * next revision, and answers the members' emails under it. Rejects,
   * changing no member and storing no revision, when the members cannot be
   * written.
   */
  save(config: DashboardAccessConfig): Promise<VisitorAllowList> {
    return this.serialize(async () => {
      await inOneTransaction(this.db, () =>
        invitedEmailsSaved(this.members, config.cloudEmailAccess),
      );
      const emails = await memberEmails(this.members);
      const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      const revision = readDashboardAccessRevision(stored) + 1;
      // An email taken off the list forgets its account, so adding it back
      // counts its next sign-in as a new account.
      const listed = new Set(emails);
      const visitorAccounts = Object.fromEntries(
        Object.entries(readVisitorAccounts(stored)).filter(([email]) => listed.has(email)),
      );
      await this.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
        ...asRecord(stored),
        revision,
        visitorAccounts,
      });
      return { emails, revision };
    });
  }

  /**
   * Moves the stored revision past one Rome Cloud already holds, keeping the
   * members. Rome Cloud can hold a higher one after this instance's database
   * was reset or restored from an older backup.
   */
  raisePast(floor: number): Promise<VisitorAllowList> {
    return this.serialize(async () => {
      const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      const emails = await memberEmails(this.members);
      const current = readDashboardAccessRevision(stored);
      if (current > floor) return { emails, revision: current };
      const revision = floor + 1;
      await this.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
        ...asRecord(stored),
        revision,
        visitorAccounts: readVisitorAccounts(stored),
      });
      return { emails, revision };
    });
  }

  /**
   * Records that a member's email signed in as a visitor with a Rome Cloud
   * account. True when that email has not signed in with that account before
   * while a member's: its first sign-in, or one from an account made again or
   * moved to the email since.
   */
  recordVisitorSignIn(email: string, accountId: string): Promise<boolean> {
    const normalized = normalizeVisitorEmail(email);
    if (!normalized || !accountId) return Promise.resolve(false);
    return this.serialize(async () => {
      const account = { platform: "email", accountId: normalized };
      if ((await roleOfAccount(this.members, account)) !== "member") return false;
      const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      const visitorAccounts = readVisitorAccounts(stored);
      if (visitorAccounts[normalized] === accountId) return false;
      const { signedIn: _dropped, ...rest } = asRecord(stored);
      await this.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
        ...rest,
        visitorAccounts: { ...visitorAccounts, [normalized]: accountId },
      });
      return true;
    });
  }

  private serialize<T>(write: () => Promise<T>): Promise<T> {
    const result = this.chain.then(write);
    this.chain = result.catch(() => {});
    return result;
  }
}

// The stored record, kept whole so the list an older build wrote stays in it.
function asRecord(stored: unknown): Record<string, unknown> {
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : {};
}

// Each member's email maps to the account it last signed in with.
function readVisitorAccounts(stored: unknown): Record<string, string> {
  const raw = (stored as { visitorAccounts?: unknown } | null)?.visitorAccounts;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const accounts: Record<string, string> = {};
  for (const [email, accountId] of Object.entries(raw)) {
    const normalized = normalizeVisitorEmail(email);
    if (normalized && typeof accountId === "string" && accountId) accounts[normalized] = accountId;
  }
  return accounts;
}
