// People's repository: the Person aggregate, loaded and saved whole with its
// links, and the account verbs that move a link between persons.
// Vocabulary: docs/domains/people.md.

import { readdir } from "node:fs/promises";
import { eq, and, or, sql, ne, like, inArray, exists, notExists } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { Account } from "@rome-os/app-runtime";
import { persons, links, dismissedAccounts } from "../schema.js";
import { type DrizzleDb, inTransaction, type SqliteExec } from "../index.js";
import { getRelationshipDir } from "../../profile-memory.js";
import {
  generatePersonSlug,
  nextAvailablePersonId,
  protectedPersonReason,
} from "@rome/api-types/persons";

export type BondLevel = "guardian" | "inner-circle" | "acquaintance" | "other";

/**
 * The account a link names, the way Chats names it: the platform and the
 * platform's own id for it (docs/domains/chats.md#account). One account is one
 * link whichever of Rome's accounts met it.
 */
export type Link = Account;

/**
 * One of a person's links. `delegate` is set on a
 * [delegate link](docs/domains/people.md#delegate-link): the account is an
 * agent's, acting for this person. Absent on the person's own accounts.
 */
export interface PersonLink extends Link {
  delegate?: true;
}

/** Someone the guardian knows, with every account linked to them. */
export interface Person {
  id: string;
  displayName: string;
  bondLevel: BondLevel;
  profilePath: string | null;
  approved: boolean;
  createdAt: Date;
  links: PersonLink[];
}

/** A person as {@link PeopleRepository.create} takes them. */
export interface NewPerson {
  displayName: string;
  bondLevel: BondLevel;
  profilePath?: string;
  approved?: boolean;
}

/** The fields of a person that change in place. */
export type PersonChanges = Partial<{
  displayName: string;
  bondLevel: BondLevel;
  profilePath: string | null;
  approved: boolean;
}>;

/** A dismissed account. */
export type Dismissal = Link;

/** An account a person already holds, and the person holding it. */
export interface AccountHolder extends Link {
  personId: string;
  personName: string;
}

/**
 * Thrown when a create would take an account a real person already holds.
 *
 * Carries the holder rather than only reporting that there is one: every
 * caller has to name them, because the guardian decides whether to move the
 * account and cannot decide without knowing whose it is.
 *
 * A dismissed account has no holder. A dismissal names no person, so naming
 * its sender takes the account with nothing to refuse.
 */
export class AccountHeldError extends Error {
  constructor(readonly holder: AccountHolder) {
    super(`Account ${holder.platform}:${holder.id} already belongs to person "${holder.personId}"`);
    this.name = "AccountHeldError";
  }
}

/** What a link, move or dismiss did: took the account, or refused it and named
 *  whoever holds it — null where nobody does, which is what a stale move runs
 *  into.
 *
 *  A result rather than an {@link AccountHeldError}: a refused link is the
 *  ordinary answer to a stale page, not the exceptional one it is for a create,
 *  where the account is the reason the person was being written at all. */
export type LinkResult = { linked: true } | { linked: false; holder: AccountHolder | null };

/** What a {@link PeopleRepository.merge} attempt did: absorbed the source,
 *  links and all, or refused and said which rule stopped it. The reason rather
 *  than the sentence, so the wording a caller answers with stays the
 *  contract's rather than this table's. */
export type MergeResult = { merged: true; links: number } | { merged: false; reason: MergeRefusal };

/** Why a merge did not happen. "unknown-*" describes an id that names nobody,
 *  and "guardian-source" a person who exists and stays. */
export type MergeRefusal = "same-person" | "unknown-target" | "unknown-source" | "guardian-source";

/** What a {@link PeopleRepository.delete} attempt did: removed the person and
 *  returned this many accounts to strangers, or refused because the id names
 *  nobody or names the guardian. */
export type DeleteResult =
  | { deleted: true; links: number }
  | { deleted: false; reason: "unknown" | "guardian" };

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
    approved: row.approved ?? false,
    createdAt: row.createdAt,
    links,
  };
}

/**
 * The people the guardian knows, each loaded whole with their links, and the
 * accounts the guardian dismissed.
 *
 * Reads answer {@link Person}. Writes on an account take a {@link Link} and
 * hold two rules: one account has at most one link, which the unique index on
 * the links table backstops, and an account is linked or dismissed, never
 * both, which every write that links an account keeps by deleting its
 * dismissal in the same transaction. Writes that a caller enlists in its own
 * transaction take an executor last, defaulting to this repository's database.
 */
export class PeopleRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** The person `id` names, or null. */
  async byId(id: string): Promise<Person | null> {
    const row = this.db.select().from(persons).where(eq(persons.id, id)).get();
    return row ? (await this.withLinks([row]))[0] : null;
  }

  /**
   * Who is this: the person the account is linked to, or null. An account is
   * one link whichever of Rome's accounts met it, so a Telegram sender heard by
   * the bot and by the signed-in user is one person. Feishu's open_id is issued
   * per app, so a sender on a second Feishu app is a second account there.
   */
  async byAccount(account: Link): Promise<Person | null> {
    const row = this.db
      .select({ person: persons })
      .from(links)
      .innerJoin(persons, eq(links.personId, persons.id))
      .where(accountIs(account))
      .get();
    return row ? (await this.withLinks([row.person]))[0] : null;
  }

  /** Every person named exactly `displayName`. */
  async byName(displayName: string): Promise<Person[]> {
    const rows = await this.db.select().from(persons).where(eq(persons.displayName, displayName));
    return this.withLinks(rows);
  }

  /** The first person named `displayName` in any case. */
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

  /**
   * Every person with their links, read as one statement.
   *
   * One statement rather than one per person, and not only to save the reads:
   * a link moving between two people mid-read would otherwise land under both
   * of them (or neither), because each person's links would arrive in their
   * own autocommit query. Every reader of this table assumes an account has
   * one owner.
   */
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

  /** Every dismissed account. */
  async dismissals(): Promise<Dismissal[]> {
    const rows = await this.db.select().from(dismissedAccounts);
    return rows.map((row) => ({ platform: row.platform, id: row.accountId }));
  }

  /** Whether the guardian dismissed the account. Who is this answers nobody
   *  for it, the same as for a stranger. */
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

  /**
   * Create a person and link their accounts, both or neither.
   *
   * A dismissed account is taken, its dismissal deleted: naming its sender is
   * the answer the dismissal declined to give. An account a person holds stays
   * held: this throws {@link AccountHeldError} instead of stealing
   * it, because creating a person is not a move. The refusal is a rollback,
   * not a partial write — a person committed without their account would be
   * unreachable and permanent, since {@link byName} would then reject every
   * retry as a duplicate of the wreckage.
   *
   * Whatever the caller names, all of it or none of it: the accounts are
   * settled together before the transaction opens, so one held account in a
   * list of five leaves the other four where they were.
   */
  async create(data: NewPerson & { links?: Link[] }): Promise<string> {
    const id = await this.mintId(data.displayName);

    const claims = await this.resolveClaims(data.links ?? []);

    this.db.transaction((tx) => {
      this.insertPerson(tx, id, data);
      for (const claim of claims) this.writeClaim(tx, id, claim);
    });

    return id;
  }

  /** Create a person under an id the caller chose, with no links. */
  async createWithId(id: string, data: NewPerson): Promise<string> {
    this.insertPerson(this.db, id, data);
    return id;
  }

  async update(id: string, changes: PersonChanges): Promise<void> {
    await this.db.update(persons).set(changes).where(eq(persons.id, id));
  }

  /**
   * Move every link `from` holds onto `into` and delete `from`, or do neither.
   *
   * One transaction because a merge is a re-attribution of history: half of a
   * duplicate's accounts moved is a state no guardian asked for and no retry
   * repairs — the second attempt reads a source that is missing the links it
   * already gave away, so it looks like a smaller duplicate than it is.
   *
   * The links move rather than being rewritten, so each carries its
   * channel-side name across the way a move does. Nothing can collide on the
   * unique index: an account carries at most one link, so no account is held
   * by both people to begin with.
   *
   * Both rows are read inside the transaction and the refusals are decided
   * there, so a source that was deleted or a person that was never there
   * cannot be reported as a merge that moved nothing. The caller phrases the
   * refusal; this decides it.
   *
   * The persons row is the whole of what is deleted. The link table is the
   * only thing that references it, so nothing is left pointing at an id that
   * is gone — and nothing outside the database is touched, memory files
   * included, because a file cannot join this transaction.
   */
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

  /**
   * Delete a person and every link they hold, so their accounts are strangers
   * again (docs/domains/people.md#person). Nothing is dismissed on the way: the
   * guardian deleted a person, not a decision about each account.
   *
   * The links and the person go in one transaction, so no reader sees links
   * onto a person who is gone. The guardian anchors the ladder and is refused.
   */
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

  /**
   * Link an account nobody holds to `personId`.
   *
   * Claims a stranger, a dismissed account, or one this person already holds,
   * which is the same request arriving twice. An account another person holds
   * is refused and its holder named: taking it is {@link move}, the guardian's
   * explicit act.
   */
  async link(account: Link, personId: string): Promise<LinkResult> {
    return this.swap(account, null, personId);
  }

  /**
   * Move an account from `from` to `to`, if `from` still holds it.
   *
   * The read and the move are one transaction, so of two callers working from
   * the same page exactly one lands the account: the loser's expected owner is
   * no longer the owner by the time its own transaction reads, and it is
   * refused rather than overwriting a move it never saw.
   */
  async move(account: Link, from: string, to: string): Promise<LinkResult> {
    return this.swap(account, from, to);
  }

  /**
   * Dismiss an account nobody holds. Dismissing an account already dismissed
   * is the same request arriving twice, and lands.
   *
   * Decided on the same terms as {@link link}, in one transaction: an account a
   * person holds is refused and its holder named, rather than its link
   * dropped and the person lost.
   */
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

  /**
   * Restore dismissed addresses of one account to strangers, as a single
   * statement.
   *
   * Every address in one statement because they are one decision: a channel
   * can reach an account several ways, a dismissal is stored against whichever
   * one the guardian dismissed it by, and an undo that committed some of them
   * would leave the account still dismissed by the address it missed. Links
   * are not touched, so an address a person holds is left where it is.
   */
  async restore(platform: string, addresses: readonly string[]): Promise<number> {
    return this.releaseDismissals(this.db, platform, addresses);
  }

  /**
   * Link an account to `personId` because a platform says it is theirs, in
   * `exec`.
   *
   * Unlike {@link link}, this takes the account from whoever held it: the
   * platform's statement about whose account it is outranks an earlier link.
   * Claiming is one statement, not a read followed by a write, so a second
   * writer re-points the link instead of adding a rival one, whatever order
   * the two arrive in. A dismissal of the account goes with it, in the same
   * transaction. Returns the link row's id.
   */
  linkStated(account: Link, personId: string, exec: SqliteExec = this.db): string {
    return this.claim(account, personId, false, exec);
  }

  /**
   * Link an agent's account to the person behind the agent, because a
   * platform says the agent is theirs, as a
   * [delegate link](docs/domains/people.md#delegate-link). Rome Cloud says so
   * for the guardian's own agents.
   *
   * Claims on the same terms as {@link linkStated}, and marks the link a
   * delegate whether it was new or re-pointed. Returns the link row's id.
   */
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

  /**
   * Re-address one of a person's accounts from `account.id` to `to`, in
   * `exec`, leaving their other accounts on that platform alone. Heals
   * a stale guardian self address (e.g. a device-suffixed WhatsApp id captured
   * before canonicalization) onto its canonical form on reconnect.
   *
   * Takes `to` from whoever else holds it, on the same terms as
   * {@link linkStated}: this is the channel reporting the address its account
   * answers to now, so a rival claim on it is the stale one. Returns false when
   * the person does not hold the account, having moved nothing.
   */
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

  /**
   * Drop the account's link. Named `from`, only that person's link goes, and
   * the result reports whether it was theirs to drop, which is the only way a
   * caller can tell an unlink from a no-op. Unnamed, whoever holds it loses
   * it. Either way the account becomes a stranger.
   */
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
        approved: data.approved ?? false,
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
