import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  DASHBOARD_ACCESS_SETTING_KEY,
  normalizeDashboardAccessConfig,
  readDashboardAccessRevision,
  type DashboardAccessConfig,
} from "./dashboard-access-config.js";

/** The dashboard allow-list as Rome Cloud receives it, with the revision it was saved under. */
export interface VisitorAllowList {
  emails: readonly string[];
  revision: number;
}

/**
 * Owns the stored dashboard allow-list and its revision. Every write runs one at
 * a time, so each save gets its own revision and a raise never loses a save.
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
      await this.settingsRepo.set(DASHBOARD_ACCESS_SETTING_KEY, { ...config, revision });
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
      });
      return { emails: list.emails, revision };
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
