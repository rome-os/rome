// Access's rules of roles: which role each person has in this Rome. It knows
// persons only by id and depends on no other context; the steps that also
// need Identity are in application/. Vocabulary: docs/domains/access.md.

import { eq, sql } from "drizzle-orm";
import type { DrizzleDb, DrizzleTx } from "../db/index.js";
import { members } from "../db/schema.js";

/** What a person is in this Rome: its guardian, or a member. */
export type Role = "guardian" | "member";

/** A person with a role, known by their id. */
export interface Member {
  personId: string;
  role: Role;
}

/** Asked to revoke the guardian's role. The guardian's role is never revoked. */
export class GuardianRemovalError extends Error {
  constructor() {
    super("The guardian's role cannot be revoked");
    this.name = "GuardianRemovalError";
  }
}

/** Asked to make a person the guardian while another person is. */
export class GuardianTakenError extends Error {
  constructor(readonly personId: string) {
    super(`Person ${personId} cannot be the guardian: another person is`);
    this.name = "GuardianTakenError";
  }
}

/**
 * Answers who has a role in this Rome and which: exactly one guardian once
 * one is granted, and any number of members. Sessions and app permissions are
 * separate modules of the Access context, not part of this class.
 */
export class Access {
  /** The same reads and writes, answered synchronously. */
  readonly sync: SyncAccess;

  constructor(db: DrizzleDb) {
    this.sync = new SyncAccess(db);
  }

  /** The person's role, or null when they have none. */
  async roleOf(personId: string): Promise<Role | null> {
    return this.sync.roleOf(personId);
  }

  /** Every person with a role, the guardian first, then members in the order
   *  they were granted it. */
  async members(): Promise<Member[]> {
    return this.sync.members();
  }

  /**
   * Gives the person `role`. Granting a role the person has changes nothing,
   * and so does granting the guardian `member`: the guardian is never
   * demoted. Rejects with {@link GuardianTakenError}, changing nothing, when
   * `role` is guardian and another person is the guardian.
   */
  async grant(personId: string, role: Role): Promise<void> {
    this.sync.grant(personId, role);
  }

  /**
   * Takes the person's role away. Does nothing for a person with none.
   * Rejects with {@link GuardianRemovalError}, changing nothing, for the
   * guardian.
   */
  async revoke(personId: string): Promise<void> {
    this.sync.revoke(personId);
  }
}

/**
 * {@link Access}'s reads and writes, with the same answers and rules, run
 * synchronously so a caller can put several in one synchronous transaction.
 * Each throws where Access's rejects.
 */
export class SyncAccess {
  constructor(private readonly db: DrizzleDb | DrizzleTx) {}

  roleOf(personId: string): Role | null {
    return (
      this.db
        .select({ role: members.role })
        .from(members)
        .where(eq(members.identityId, personId))
        .get()?.role ?? null
    );
  }

  members(): Member[] {
    return this.db
      .select({ personId: members.identityId, role: members.role })
      .from(members)
      .orderBy(sql`${members.role} = 'guardian' DESC`, members.createdAt, sql`"members".rowid`)
      .all();
  }

  grant(personId: string, role: Role): void {
    const current = this.roleOf(personId);
    if (current === role || current === "guardian") return;
    if (role === "guardian") {
      const guardian = this.members().find((m) => m.role === "guardian");
      if (guardian) throw new GuardianTakenError(personId);
    }
    if (current === null) {
      this.db.insert(members).values({ identityId: personId, role, createdAt: new Date() }).run();
    } else {
      this.db.update(members).set({ role }).where(eq(members.identityId, personId)).run();
    }
  }

  revoke(personId: string): void {
    const current = this.roleOf(personId);
    if (current === null) return;
    if (current === "guardian") throw new GuardianRemovalError();
    this.db.delete(members).where(eq(members.identityId, personId)).run();
  }
}

/** Access over `db`. */
export function createAccess(db: DrizzleDb): Access {
  return new Access(db);
}

/** Access's synchronous reads and writes on `tx`, so they join its transaction. */
export function accessWithinTx(tx: DrizzleTx): SyncAccess {
  return new SyncAccess(tx);
}
