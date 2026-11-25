import { eq } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { settings } from "../db/schema.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  invitedEmailsSavedWithinTx,
  type MemberContext,
  memberContext,
  memberContextWithinTx,
  memberEmails,
  memberEmailsWithinTx,
  ROME_CLOUD_EMAIL_PLATFORM,
  roleOfAccount,
} from "./application/members.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  INVITED_EMAILS_DONE_KEY,
  normalizeDashboardAccessConfig,
  readDashboardAccessRevision,
  readInvitedEmailsDoneRevision,
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
 * emails are on the list. Each save also writes the members' emails into the
 * record's own copy of the list, so an older build after a rollback reads the
 * right list. This build reads that copy again only at startup, after an
 * older build saved it (backfill-members.ts). Every write runs one at a
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

  /** `settingsRepo` must read and write `db`'s settings. */
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
   * The emails the settings page shows the guardian: the members' while they
   * match the record, else the record's own list, which an older build saved
   * last and the startup import has not read. Saving the page then saves that
   * list, not a member the older build removed.
   */
  async shownEmails(): Promise<string[]> {
    if (membersMatchInvitedEmails(this.db)) return memberEmails(this.members);
    const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
    return normalizeDashboardAccessConfig(stored).cloudEmailAccess;
  }

  /**
   * Whether the members are the source of the invited emails: the members
   * backfill imported the older list, or a save ran, and no older build has
   * saved the list since. Until then the members may lack invited emails the
   * settings record holds, or hold ones it removed.
   */
  membersAreSource(): boolean {
    return (
      settingValue(this.db, INVITED_EMAILS_DONE_KEY) !== undefined &&
      membersMatchInvitedEmails(this.db)
    );
  }

  /**
   * Makes the members the persons behind the config's emails, stores the next
   * revision and the members' emails as the record's copy of the list, and
   * stores that revision as the one this build last wrote, all in one
   * transaction, and answers the members' emails under that revision.
   * Rejects, changing nothing, when any of it cannot be written. The
   * transaction holds this save's writes only.
   */
  save(config: DashboardAccessConfig): Promise<VisitorAllowList> {
    // The body is synchronous, so no other request's write on the shared
    // connection can land between BEGIN and COMMIT, where a rollback of this
    // save would undo it too.
    return this.serialize(async () => this.db.transaction((tx) => this.saveWithinTx(tx, config)));
  }

  private saveWithinTx(tx: DrizzleTx, config: DashboardAccessConfig): VisitorAllowList {
    const stored = settingValue(tx, DASHBOARD_ACCESS_SETTING_KEY);
    const revision = readDashboardAccessRevision(stored) + 1;
    const members = memberContextWithinTx(tx);
    invitedEmailsSavedWithinTx(members, config.cloudEmailAccess);
    const emails = memberEmailsWithinTx(members);
    // An email taken off the list forgets its account, so adding it back
    // counts its next sign-in as a new account.
    const listed = new Set(emails);
    const visitorAccounts = Object.fromEntries(
      Object.entries(readVisitorAccounts(stored)).filter(([email]) => listed.has(email)),
    );
    // The backfill reads the record's list again only when an older build
    // saved it past this revision.
    putSetting(tx, INVITED_EMAILS_DONE_KEY, revision);
    putSetting(tx, DASHBOARD_ACCESS_SETTING_KEY, {
      ...asRecord(stored),
      // Kept equal to the members so an older build reads the right list.
      cloudEmailAccess: emails,
      revision,
      visitorAccounts,
    });
    return { emails, revision };
  }

  /**
   * Moves the stored revision past one Rome Cloud already holds, keeping the
   * members. Rome Cloud can hold a higher one after this instance's database
   * was reset or restored from an older backup. Like a save, it stores the new
   * revision as the one this build last wrote and the members' emails as the
   * record's copy of the list, in one transaction, so the next startup reads
   * no list for it. Only an older build's save that startup has not read yet
   * keeps its list and stays to be read.
   */
  raisePast(floor: number): Promise<VisitorAllowList> {
    // One synchronous body, so the transaction holds this raise's writes only.
    return this.serialize(async () => this.db.transaction((tx) => this.raiseWithinTx(tx, floor)));
  }

  private raiseWithinTx(tx: DrizzleTx, floor: number): VisitorAllowList {
    const stored = settingValue(tx, DASHBOARD_ACCESS_SETTING_KEY);
    const emails = memberEmailsWithinTx(memberContextWithinTx(tx));
    const current = readDashboardAccessRevision(stored);
    if (current > floor) return { emails, revision: current };
    const revision = floor + 1;
    const record = { ...asRecord(stored), revision, visitorAccounts: readVisitorAccounts(stored) };
    // A record above the revision this build last wrote or read holds an older
    // build's save, which a failed backfill left unread.
    const read = readInvitedEmailsDoneRevision(settingValue(tx, INVITED_EMAILS_DONE_KEY));
    if (current <= read) {
      putSetting(tx, INVITED_EMAILS_DONE_KEY, revision);
      putSetting(tx, DASHBOARD_ACCESS_SETTING_KEY, { ...record, cloudEmailAccess: emails });
    } else {
      putSetting(tx, DASHBOARD_ACCESS_SETTING_KEY, record);
    }
    return { emails, revision };
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
      const account = { platform: ROME_CLOUD_EMAIL_PLATFORM, accountId: normalized };
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

/**
 * Whether the members hold the invited emails of the settings record's current
 * revision: the startup import or a save by this build wrote that revision, or
 * no list was ever saved. False after an older build saved the list past the
 * revision this build last wrote or read, until the import reads it or a save
 * replaces it.
 */
export function membersMatchInvitedEmails(db: DrizzleDb | DrizzleTx): boolean {
  const current = readDashboardAccessRevision(settingValue(db, DASHBOARD_ACCESS_SETTING_KEY));
  return current <= readInvitedEmailsDoneRevision(settingValue(db, INVITED_EMAILS_DONE_KEY));
}

function settingValue(tx: DrizzleDb | DrizzleTx, key: string): unknown {
  return tx.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
    ?.value;
}

function putSetting(tx: DrizzleTx, key: string, value: unknown): void {
  const updatedAt = new Date();
  tx.insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } })
    .run();
}

// The stored record, kept whole so the list an older build reads stays in it.
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
