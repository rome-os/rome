import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
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
 * Owns the stored dashboard allow-list, its revision, and the Rome Cloud
 * account each listed email last signed in as a visitor with. Every write runs
 * one at a time, so each save gets its own revision and a raise or a sign-in
 * never loses a save.
 *
 * The record replaces an older one keyed by email alone, which missed an email
 * signing in with a new account. That record is dropped on the next write, so
 * each listed visitor's next sign-in counts as a new account once.
 */
export class DashboardAccessStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly settingsRepo: Pick<SettingsRepository, "get" | "set">) {}

  async read(): Promise<VisitorAllowList> {
    return toAllowList(await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY));
  }

  /** Stores the config under the next revision. */
  save(config: DashboardAccessConfig): Promise<VisitorAllowList> {
    return this.serialize(async () => {
      const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      const revision = readDashboardAccessRevision(stored) + 1;
      // An email taken off the list forgets its account, so adding it back
      // counts its next sign-in as a new account.
      const listed = new Set(config.cloudEmailAccess);
      const visitorAccounts = Object.fromEntries(
        Object.entries(readVisitorAccounts(stored)).filter(([email]) => listed.has(email)),
      );
      await this.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
        ...config,
        revision,
        visitorAccounts,
      });
      return { emails: config.cloudEmailAccess, revision };
    });
  }

  /**
   * Moves the stored revision past one Rome Cloud already holds, keeping the
   * list. Rome Cloud can hold a higher one after this instance's database was
   * reset or restored from an older backup.
   */
  raisePast(floor: number): Promise<VisitorAllowList> {
    return this.serialize(async () => {
      const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      const list = toAllowList(stored);
      if (list.revision > floor) return list;
      const revision = floor + 1;
      await this.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, {
        cloudEmailAccess: [...list.emails],
        revision,
        visitorAccounts: readVisitorAccounts(stored),
      });
      return { emails: list.emails, revision };
    });
  }

  /**
   * Records that a listed email signed in as a visitor with a Rome Cloud
   * account. True when that email has not signed in with that account before
   * while on the list: its first sign-in, or one from an account made again
   * or moved to the email since.
   */
  recordVisitorSignIn(email: string, accountId: string): Promise<boolean> {
    const normalized = normalizeVisitorEmail(email);
    if (!normalized || !accountId) return Promise.resolve(false);
    return this.serialize(async () => {
      const stored = await this.settingsRepo.get(DASHBOARD_ACCESS_SETTING_KEY);
      if (!toAllowList(stored).emails.includes(normalized)) return false;
      const visitorAccounts = readVisitorAccounts(stored);
      if (visitorAccounts[normalized] === accountId) return false;
      const { signedIn: _dropped, ...rest } = (stored ?? {}) as Record<string, unknown>;
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

function toAllowList(stored: unknown): VisitorAllowList {
  return {
    emails: normalizeDashboardAccessConfig(stored).cloudEmailAccess,
    revision: readDashboardAccessRevision(stored),
  };
}

// Each listed email maps to the account it last signed in with.
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
