// People's repository on Drizzle: the persons, links and dismissed-accounts
// tables behind the PeopleRepository port. Vocabulary: docs/domains/people.md.

import { readdir } from "node:fs/promises";
import { eq, and, or, sql, ne, like, inArray, exists, notExists } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { BondLevel } from "@rome-os/app-runtime";
import { persons, links, dismissedAccounts } from "../../db/schema.js";
import { type DrizzleDb, inTransaction, type SqliteExec } from "../../db/index.js";
import { getRelationshipDir } from "../../profile-memory.js";
import {
  generatePersonSlug,
  nextAvailablePersonId,
  protectedPersonReason,
} from "@rome/api-types/persons";
import {
  PersonLink,
  Person,
  Link,
  Dismissal,
  NewPerson,
  PersonChanges,
  MergeResult,
  DeleteResult,
  LinkResult,
  AccountHolder,
  AccountHeldError,
} from "../model/person.js";
import type { PeopleRepository } from "../model/people-repository.js";

type PersonRow = typeof persons.$inferSelect;

/** A stored link as a reader gets it, the delegate mark only where it is set. */
function toPersonLink(row: typeof links.$inferSelect): PersonLink {
  return {
    platform: row.platform,
    id: row.accountId,
    ...(row.delegate ? { delegate: true as const } : {}),
  };
}

function toPerson(row: PersonRow, links: PersonLink[]): Person {
  return {
    id: row.id,
    displayName: row.displayName,
    bondLevel: row.bondLevel,
    profilePath: row.profilePath,
    createdAt: row.createdAt,
    links,
  };
}

/** {@link PeopleRepository} on the persons, links and dismissed-accounts tables. */
export class DrizzlePeopleRepository implements PeopleRepository {
  constructor(private readonly db: DrizzleDb) {}

  async byId(id: string): Promise<Person | null> {
    const row = this.db.select().from(persons).where(eq(persons.id, id)).get();
    return row ? (await this.withLinks([row]))[0] : null;
  }

  async byAccount(account: Link): Promise<Person | null> {
    const row = this.db
      .select({ person: persons })
      .from(links)
      .innerJoin(persons, eq(links.personId, persons.id))
      .where(accountIs(account))
      .get();
    return row ? (await this.withLinks([row.person]))[0] : null;
  }

  async byName(displayName: string): Promise<Person[]> {
    const rows = await this.db.select().from(persons).where(eq(persons.displayName, displayName));
    return this.withLinks(rows);
  }

  async byNameIgnoringCase(displayName: string): Promise<Person | null> {
    const row = this.db
      .select()
      .from(persons)
      .where(sql`LOWER(${persons.displayName}) = LOWER(${displayName})`)
      .get();
    return row ? (await this.withLinks([row]))[0] : null;
  }

  async byBondLevel(bondLevel: BondLevel): Promise<Person[]> {
    const rows = await this.db.select().from(persons).where(eq(persons.bondLevel, bondLevel));
    return this.withLinks(rows);
  }

  async all(): Promise<Person[]> {
    const rows = await this.db
      .select({ person: persons, link: links })
      .from(persons)
      .leftJoin(links, eq(links.personId, persons.id));

    const byPerson = new Map<string, Person>();
    for (const row of rows) {
      let person = byPerson.get(row.person.id);
      if (!person) {
        person = toPerson(row.person, []);
        byPerson.set(row.person.id, person);
      }
      if (row.link) person.links.push(toPersonLink(row.link));
    }
    return [...byPerson.values()];
  }

  async dismissals(): Promise<Dismissal[]> {
    const rows = await this.db.select().from(dismissedAccounts);
    return rows.map((row) => ({ platform: row.platform, id: row.accountId }));
  }

  async isDismissed(account: Link): Promise<boolean> {
    return this.dismissalOf(account) != null;
  }

  /** `rows` as persons, each with their links. */
  private async withLinks(rows: PersonRow[]): Promise<Person[]> {
    if (rows.length === 0) return [];
    const held = await this.db
      .select()
      .from(links)
      .where(
        inArray(
          links.personId,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) =>
      toPerson(row, held.filter((link) => link.personId === row.id).map(toPersonLink)),
    );
  }

  async create(data: NewPerson & { links?: Link[] }): Promise<string> {
    const id = await this.mintId(data.displayName);

    const claims = await this.resolveClaims(data.links ?? []);

    this.db.transaction((tx) => {
      this.insertPerson(tx, id, data);
      for (const claim of claims) this.writeClaim(tx, id, claim);
    });

    return id;
  }

  async createWithId(id: string, data: NewPerson): Promise<string> {
    this.insertPerson(this.db, id, data);
    return id;
  }

  async update(id: string, changes: PersonChanges): Promise<void> {
    await this.db.update(persons).set(changes).where(eq(persons.id, id));
  }

  async merge(into: string, from: string): Promise<MergeResult> {
    return this.db.transaction((tx): MergeResult => {
      // Guarded here as well as by the caller: this transaction would move a
      // person's links onto themselves and then delete them, which is the one
      // outcome a merge must never have.
      if (into === from) return { merged: false, reason: "same-person" };

      const rows = tx
        .select({ id: persons.id, bondLevel: persons.bondLevel })
        .from(persons)
        .where(inArray(persons.id, [into, from]))
        .all();

      const target = rows.find((row) => row.id === into);
      const source = rows.find((row) => row.id === from);
      if (!target) return { merged: false, reason: "unknown-target" };
      if (!source) return { merged: false, reason: "unknown-source" };
      // The guardian anchors the ladder, so they may not be merged away.
      if (protectedPersonReason(source) === "guardian") {
        return { merged: false, reason: "guardian-source" };
      }

      const moved = tx.update(links).set({ personId: into }).where(eq(links.personId, from)).run();
      tx.delete(persons).where(eq(persons.id, from)).run();

      return { merged: true, links: moved.changes };
    });
  }

  async delete(personId: string): Promise<DeleteResult> {
    return this.db.transaction((tx): DeleteResult => {
      const row = tx
        .select({ bondLevel: persons.bondLevel })
        .from(persons)
        .where(eq(persons.id, personId))
        .get();
      if (!row) return { deleted: false, reason: "unknown" };
      if (protectedPersonReason(row) === "guardian") return { deleted: false, reason: "guardian" };

      const released = tx.delete(links).where(eq(links.personId, personId)).run();
      tx.delete(persons).where(eq(persons.id, personId)).run();
      return { deleted: true, links: released.changes };
    });
  }

  async link(account: Link, personId: string): Promise<LinkResult> {
    return this.swap(account, null, personId);
  }

  async move(account: Link, from: string, to: string): Promise<LinkResult> {
    return this.swap(account, from, to);
  }

  async dismiss(account: Link): Promise<LinkResult> {
    return this.db.transaction((tx): LinkResult => {
      const holder = this.holderOf(account, tx);
      if (holder) return { linked: false, holder };
      tx.insert(dismissedAccounts)
        .values({ platform: account.platform, accountId: account.id })
        .onConflictDoNothing()
        .run();
      return { linked: true };
    });
  }

  async restore(platform: string, addresses: readonly string[]): Promise<number> {
    return this.releaseDismissals(this.db, platform, addresses);
  }

  linkStated(account: Link, personId: string, exec: SqliteExec = this.db): string {
    return this.claim(account, personId, false, exec);
  }

  linkDelegate(account: Link, personId: string): string {
    return this.claim(account, personId, true, this.db);
  }

  /** The claim {@link linkStated} and {@link linkDelegate} share. Only a
   *  delegate claim writes the mark, so a platform's statement about an
   *  account's owner never clears one. */
  private claim(account: Link, personId: string, delegate: boolean, exec: SqliteExec): string {
    // Called without a transaction, it opens its own: releasing the dismissal
    // and writing the link are one decision, and a link that fails must leave
    // the dismissal standing.
    if (!inTransaction(this.db)) {
      return this.db.transaction((tx) => this.claim(account, personId, delegate, tx));
    }
    this.releaseDismissals(exec, account.platform, [account.id]);
    const row = exec
      .insert(links)
      .values({
        id: uuid(),
        personId,
        platform: account.platform,
        accountId: account.id,
        delegate,
      })
      .onConflictDoUpdate({
        target: [links.platform, links.accountId],
        set: { personId, ...(delegate ? { delegate } : {}) },
      })
      // Re-pointing keeps the existing row, whose id is not the one minted
      // above. Returning the row's own id keeps the reported link real.
      .returning({ id: links.id })
      .get();
    return row.id;
  }

  readdress(personId: string, account: Link, to: string, exec: SqliteExec = this.db): boolean {
    const { platform } = account;
    const from = account.id;
    // The row this call re-points, as a subquery so the guard runs inside the
    // caller's transaction rather than as a read before it.
    const rePointed = this.db
      .select({ id: links.id })
      .from(links)
      .where(
        and(eq(links.personId, personId), eq(links.platform, platform), eq(links.accountId, from)),
      );

    // A rival holding `to` yields it, which is where {@link linkStated}'s
    // upsert lands a claim on the same account. Re-pointing onto a held
    // identifier would otherwise collide on the unique index and abort the
    // caller's transaction — the one outcome a claim on this path must not have,
    // since that transaction also carries the credential.
    //
    // Only a rival's. This person holding `to` themselves is a second account of
    // theirs, not a claim to settle, and deleting it here would merge two of
    // their accounts into one. Conditioned, too, on the re-pointed row still
    // being there: a `from` that went away leaves the rival holding an account
    // nothing is about to take.
    exec
      .delete(links)
      .where(
        and(
          eq(links.platform, platform),
          eq(links.accountId, to),
          ne(links.personId, personId),
          exists(rePointed),
        ),
      )
      .run();
    // A dismissal of `to` yields on the same terms: the account is about to be
    // this person's, and a linked account is never also dismissed.
    exec
      .delete(dismissedAccounts)
      .where(
        and(
          eq(dismissedAccounts.platform, platform),
          eq(dismissedAccounts.accountId, to),
          exists(rePointed),
        ),
      )
      .run();

    // Whoever still holds `to` after that yield is this person, so the re-point
    // has nothing left to do and says so rather than colliding on the index.
    const stillHeld = this.db
      .select({ id: links.id })
      .from(links)
      .where(and(eq(links.platform, platform), eq(links.accountId, to)));

    // Scoped to the one account being re-pointed, not to every account the
    // person holds on the channel: a person may hold several there, and moving
    // them all onto `to` would collide on the unique index too.
    const result = exec
      .update(links)
      .set({ accountId: to })
      .where(
        and(
          eq(links.personId, personId),
          eq(links.platform, platform),
          eq(links.accountId, from),
          notExists(stillHeld),
        ),
      )
      .run();
    return result.changes > 0;
  }

  async unlink(account: Link, from?: string): Promise<boolean> {
    const result = this.db
      .delete(links)
      .where(and(accountIs(account), from === undefined ? undefined : eq(links.personId, from)))
      .run();
    return result.changes > 0;
  }

  /**
   * Take the account for `to` if `expected` holds it at the moment of the
   * write, where a null `expected` is a claim on an account nobody holds — a
   * stranger, a dismissed account, or one `to` already holds. Every other case
   * refuses and names the holder. A dismissal of the account goes with a
   * landed swap.
   */
  private swap(account: Link, expected: string | null, to: string): LinkResult {
    return this.db.transaction((tx): LinkResult => {
      const link = tx
        .select({ id: links.id, personId: links.personId, personName: persons.displayName })
        .from(links)
        .innerJoin(persons, eq(persons.id, links.personId))
        .where(accountIs(account))
        .get();

      const holder: AccountHolder | null = link
        ? { ...account, personId: link.personId, personName: link.personName }
        : null;

      const swapped =
        expected === null
          ? holder === null || holder.personId === to
          : holder?.personId === expected;
      if (!swapped) return { linked: false, holder };

      this.releaseDismissals(tx, account.platform, [account.id]);
      if (link == null) {
        tx.insert(links)
          .values({ id: uuid(), personId: to, platform: account.platform, accountId: account.id })
          .run();
      } else if (link.personId !== to) {
        // The row moves rather than being replaced, so a delegate mark it
        // carries survives a move.
        tx.update(links).set({ personId: to }).where(eq(links.id, link.id)).run();
      }
      return { linked: true };
    });
  }

  private async mintId(displayName: string): Promise<string> {
    const base = generatePersonSlug(displayName);
    if (!base) return uuid();

    const rows = await this.db
      .select({ id: persons.id })
      .from(persons)
      .where(or(eq(persons.id, base), like(persons.id, `${base}-%`)));
    // A deleted or merged-away person's profile stays in Memory under their
    // id, and a profile is found by id. So that id stays retired: a new person
    // minted onto it would open with prose about somebody else.
    const profiled = await profiledIds(base);

    return nextAvailablePersonId(base, [...rows.map((row) => row.id), ...profiled]);
  }

  /**
   * Settle who may take each account, before any transaction opens, so a
   * refusal can name the holder. A dismissed account is released to whoever
   * names its sender; one a person holds is refused. The unique index still
   * backstops a rival claim landing between this read and the write.
   */
  private async resolveClaims(accounts: Link[]): Promise<Link[]> {
    for (const account of accounts) {
      const held = this.holderOf(account);
      if (held) throw new AccountHeldError(held);
    }
    return accounts.map(({ platform, id }) => ({ platform, id }));
  }

  /** Take an account {@link resolveClaims} cleared for this person. */
  private writeClaim(exec: SqliteExec, personId: string, claim: Link): void {
    this.releaseDismissals(exec, claim.platform, [claim.id]);
    exec
      .insert(links)
      .values({ id: uuid(), personId, platform: claim.platform, accountId: claim.id })
      .run();
  }

  /** Delete the dismissals of these addresses. Links are never touched, so an
   *  account a person holds stays placed and the unique index turns an attempt
   *  to take it into a rollback rather than a silent theft. */
  private releaseDismissals(
    exec: SqliteExec,
    platform: string,
    addresses: readonly string[],
  ): number {
    if (addresses.length === 0) return 0;
    return exec
      .delete(dismissedAccounts)
      .where(
        and(
          eq(dismissedAccounts.platform, platform),
          inArray(dismissedAccounts.accountId, [...addresses]),
        ),
      )
      .run().changes;
  }

  /** The person holding an account, or null when nobody does. The join loses
   *  nothing — every link references a person row. */
  private holderOf(account: Link, exec: Pick<DrizzleDb, "select"> = this.db): AccountHolder | null {
    const row = exec
      .select({ personId: links.personId, personName: persons.displayName })
      .from(links)
      .innerJoin(persons, eq(links.personId, persons.id))
      .where(accountIs(account))
      .get();
    return row ? { platform: account.platform, id: account.id, ...row } : null;
  }

  /** The account's dismissal, or null when it is not dismissed. */
  private dismissalOf(account: Link, exec: Pick<DrizzleDb, "select"> = this.db): Dismissal | null {
    const row = exec
      .select()
      .from(dismissedAccounts)
      .where(
        and(
          eq(dismissedAccounts.platform, account.platform),
          eq(dismissedAccounts.accountId, account.id),
        ),
      )
      .get();
    return row ? { platform: row.platform, id: row.accountId } : null;
  }

  private insertPerson(exec: SqliteExec, id: string, data: NewPerson): void {
    exec
      .insert(persons)
      .values({
        id,
        displayName: data.displayName,
        bondLevel: data.bondLevel,
        profilePath: data.profilePath ?? null,
        createdAt: new Date(),
      })
      .run();
  }
}

/** The condition that picks the link naming `account`. */
function accountIs(account: Link) {
  return and(eq(links.platform, account.platform), eq(links.accountId, account.id));
}

/** The ids `base` or `base-N` that have a profile in the relationship
 *  directory, whether or not anyone holds them now. */
async function profiledIds(base: string): Promise<string[]> {
  const files = await readdir(getRelationshipDir()).catch(() => [] as string[]);
  return files
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -".md".length))
    .filter((id) => id === base || id.startsWith(`${base}-`));
}
