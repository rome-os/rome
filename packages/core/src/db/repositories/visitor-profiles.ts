import { inArray } from "drizzle-orm";
import { visitorProfiles } from "../schema.js";
import type { DrizzleDb } from "../index.js";

export interface VisitorProfile {
  email: string;
  avatarUrl: string | null;
}

export class VisitorProfilesRepository {
  constructor(private db: DrizzleDb) {}

  /** Keep the profile a visitor just signed in with, replacing any older one. */
  async record(accountId: string, profile: VisitorProfile): Promise<void> {
    const updatedAt = new Date();
    await this.db
      .insert(visitorProfiles)
      .values({ accountId, ...profile, updatedAt })
      .onConflictDoUpdate({
        target: visitorProfiles.accountId,
        set: { ...profile, updatedAt },
      });
  }

  async getMany(accountIds: readonly string[]): Promise<Map<string, VisitorProfile>> {
    if (accountIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        accountId: visitorProfiles.accountId,
        email: visitorProfiles.email,
        avatarUrl: visitorProfiles.avatarUrl,
      })
      .from(visitorProfiles)
      .where(inArray(visitorProfiles.accountId, [...accountIds]));
    return new Map(rows.map(({ accountId, ...profile }) => [accountId, profile]));
  }
}
