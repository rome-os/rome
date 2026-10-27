// People's repository: the Person aggregate, loaded and saved whole with its
// links, and the account verbs that move a link between persons.
// Vocabulary: docs/domains/people.md.

import { eq, and, sql, ne, like, inArray, exists, notExists } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { persons, channelMappings, dismissedAccounts } from "../schema.js";
import type { ConnectionKindOfChannel } from "./channel-records.js";
import { type DrizzleDb, inTransaction, type SqliteExec } from "../index.js";
import {
  generatePersonSlug,
  nextAvailablePersonId,
  protectedPersonReason,
} from "@rome/api-types/persons";

export type BondLevel = "guardian" | "inner-circle" | "acquaintance" | "other";

/**
 * The account a link names: the channel it is keyed under and the channel's
 * own id for it. The stored rows keep the `channel_mappings` table and its
 * column names; this is the shape every reader gets.
 */
export interface Link {
  channel: string;
  channelUserId: string;
}

/** Someone the guardian knows, with every account linked to them. */
export interface Person {
  id: string;
  displayName: string;
  bondLevel: BondLevel;
  profilePath: string | null;
  approved: boolean;
  createdAt: Date;
  links: Link[];
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

/** A dismissed account, with the channel's name for it when it was
 *  dismissed. */
export interface Dismissal extends Link {
  displayName: string | null;
}

/** An account cleared for a person to take, with the channel-side name that
 *  travels with it. */
interface Claim extends Link {
  displayName: string | null;
}

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
    super(
      `Account ${holder.channel}:${holder.channelUserId} already belongs to person "${holder.personId}"`,
    );
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

type PersonRow = typeof persons.$inferSelect;

function toPerson(row: PersonRow, links: Link[]): Person {
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
  /** `connectionKindOf` maps a channel to the connection kind a link is keyed by: People keys
   *  an account by connection kind, so a later channel of a connection kind reads and writes
   *  the connection kind's links. */
  constructor(
    private readonly db: DrizzleDb,
    private readonly connectionKindOf: ConnectionKindOfChannel,
  ) {}

  /** The key People files a link to an account on `channel` under. */
  linkKeyOf(channel: string): string {
    return this.connectionKindOf(channel);
  }

  /** The person `id` names, or null. */
  async byId(id: string): Promise<Person | null> {
    const row = this.db.select().from(persons).where(eq(persons.id, id)).get();
    return row ? (await this.withLinks([row]))[0] : null;
  }

  /**
   * Who is this: the person the account is linked to, or null. A later channel
   * of a connection kind reads the connection kind's links: People keys an
   * account by connection kind. Telegram and Discord give a person one id
   * across bots. Feishu's open_id is issued per app, so a sender on a second
   * Feishu bot is linked once there.
   */
  async byAccount(account: Link): Promise<Person | null> {
    const channel = this.connectionKindOf(account.channel);
    const row = this.db
      .select({ person: persons })
      .from(channelMappings)
      .innerJoin(persons, eq(channelMappings.personId, persons.id))
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, account.channelUserId),
        ),
      )
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
      .select({ person: persons, link: channelMappings })
      .from(persons)
      .leftJoin(channelMappings, eq(channelMappings.personId, persons.id));

    const byPerson = new Map<string, Person>();
    for (const row of rows) {
      let person = byPerson.get(row.person.id);
      if (!person) {
        person = toPerson(row.person, []);
        byPerson.set(row.person.id, person);
      }
      if (row.link) {
        person.links.push({ channel: row.link.channel, channelUserId: row.link.channelUserId });
      }
    }
    return [...byPerson.values()];
  }

  /** Every dismissed account. */
  async dismissals(): Promise<Dismissal[]> {
    return this.db.select().from(dismissedAccounts);
  }

  /** Whether the guardian dismissed the account. Who is this answers nobody
   *  for it, the same as for a stranger. */
  async isDismissed(account: Link): Promise<boolean> {
    return this.dismissalOf(account) != null;
  }

  /** `rows` as persons, each with their links. */
  private async withLinks(rows: PersonRow[]): Promise<Person[]> {
    if (rows.length === 0) return [];
    const links = await this.db
      .select()
      .from(channelMappings)
      .where(
        inArray(
          channelMappings.personId,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) =>
      toPerson(
        row,
        links
          .filter((link) => link.personId === row.id)
          .map((link) => ({ channel: link.channel, channelUserId: link.channelUserId })),
      ),
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
  async create(data: NewPerson & { links?: (Link & { displayName?: string })[] }): Promise<string> {
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

      const moved = tx
        .update(channelMappings)
        .set({ personId: into })
        .where(eq(channelMappings.personId, from))
        .run();
      tx.delete(persons).where(eq(persons.id, from)).run();

      return { merged: true, links: moved.changes };
    });
  }

  /**
   * Link an account nobody holds to `personId`.
   *
   * Claims a stranger, a dismissed account, or one this person already holds, which is the same request arriving twice. An
   * account another person holds is refused and its holder named: taking it is
   * {@link move}, the guardian's explicit act.
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
    const channel = this.connectionKindOf(account.channel);
    const { channelUserId } = account;
    return this.db.transaction((tx): LinkResult => {
      const holder = this.holderOf(account, tx);
      if (holder) return { linked: false, holder };
      tx.insert(dismissedAccounts)
        .values({ channel, channelUserId, displayName: null })
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
  async restore(channel: string, addresses: readonly string[]): Promise<number> {
    return this.releaseDismissals(this.db, channel, addresses);
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
   * transaction, and the link keeps the dismissal's name when the caller has
   * none. Returns the link row's id.
   */
  linkStated(
    account: Link,
    personId: string,
    displayName?: string,
    exec: SqliteExec = this.db,
  ): string {
    // Called without a transaction, it opens its own: releasing the dismissal
    // and writing the link are one decision, and a link that fails must leave
    // the dismissal standing.
    if (!inTransaction(this.db)) {
      return this.db.transaction((tx) => this.linkStated(account, personId, displayName, tx));
    }
    const channel = this.connectionKindOf(account.channel);
    // On this connection, so it reads inside the caller's transaction.
    const dismissedAs = this.dismissalOf(account)?.displayName ?? null;
    this.releaseDismissals(exec, channel, [account.channelUserId]);
    const row = exec
      .insert(channelMappings)
      .values({
        id: uuid(),
        personId,
        channel,
        channelUserId: account.channelUserId,
        displayName: displayName ?? dismissedAs,
      })
      .onConflictDoUpdate({
        target: [channelMappings.channel, channelMappings.channelUserId],
        set: {
          personId,
          // The display name is the channel's, and every caller that has one
          // took it from an inbound message. A caller without one is reporting
          // no news, not a rename, so the stored name stands.
          displayName: sql`coalesce(excluded.${sql.raw(channelMappings.displayName.name)}, ${channelMappings.displayName})`,
        },
      })
      // Re-pointing keeps the existing row, whose id is not the one minted
      // above. Returning the row's own id keeps the reported link real.
      .returning({ id: channelMappings.id })
      .get();
    return row.id;
  }

  /**
   * Re-address one of a person's accounts from `account.channelUserId` to
   * `to`, in `exec`, leaving their other accounts on that channel alone. Heals
   * a stale guardian self address (e.g. a device-suffixed WhatsApp id captured
   * before canonicalization) onto its canonical form on reconnect.
   *
   * Takes `to` from whoever else holds it, on the same terms as
   * {@link linkStated}: this is the channel reporting the address its account
   * answers to now, so a rival claim on it is the stale one. Returns false when
   * the person does not hold the account, having moved nothing.
   */
  readdress(personId: string, account: Link, to: string, exec: SqliteExec = this.db): boolean {
    const channel = this.connectionKindOf(account.channel);
    const from = account.channelUserId;
    // The row this call re-points, as a subquery so the guard runs inside the
    // caller's transaction rather than as a read before it.
    const rePointed = this.db
      .select({ id: channelMappings.id })
      .from(channelMappings)
      .where(
        and(
          eq(channelMappings.personId, personId),
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, from),
        ),
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
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, to),
          ne(channelMappings.personId, personId),
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
          eq(dismissedAccounts.channel, channel),
          eq(dismissedAccounts.channelUserId, to),
          exists(rePointed),
        ),
      )
      .run();

    // Whoever still holds `to` after that yield is this person, so the re-point
    // has nothing left to do and says so rather than colliding on the index.
    const stillHeld = this.db
      .select({ id: channelMappings.id })
      .from(channelMappings)
      .where(and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, to)));

    // Scoped to the one account being re-pointed, not to every account the
    // person holds on the channel: a person may hold several there, and moving
    // them all onto `to` would collide on the unique index too.
    const result = exec
      .update(channelMappings)
      .set({ channelUserId: to })
      .where(
        and(
          eq(channelMappings.personId, personId),
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, from),
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
    const channel = this.connectionKindOf(account.channel);
    const result = this.db
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, account.channelUserId),
          from === undefined ? undefined : eq(channelMappings.personId, from),
        ),
      )
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
    const channel = this.connectionKindOf(account.channel);
    const { channelUserId } = account;

    return this.db.transaction((tx): LinkResult => {
      const link = tx
        .select({
          id: channelMappings.id,
          personId: channelMappings.personId,
          personName: persons.displayName,
        })
        .from(channelMappings)
        .innerJoin(persons, eq(persons.id, channelMappings.personId))
        .where(
          and(
            eq(channelMappings.channel, channel),
            eq(channelMappings.channelUserId, channelUserId),
          ),
        )
        .get();

      const holder: AccountHolder | null = link
        ? { channel, channelUserId, personId: link.personId, personName: link.personName }
        : null;

      const swapped =
        expected === null
          ? holder === null || holder.personId === to
          : holder?.personId === expected;
      if (!swapped) return { linked: false, holder };

      const dismissal = this.dismissalOf(account, tx);
      this.releaseDismissals(tx, channel, [channelUserId]);
      if (link == null) {
        // The channel's name for the account is not this caller's to supply —
        // a link names an account, and what to call it comes from the provider
        // directory at read time. A dismissal's name carries over, the way a
        // move keeps the link's.
        tx.insert(channelMappings)
          .values({
            id: uuid(),
            personId: to,
            channel,
            channelUserId,
            displayName: dismissal?.displayName ?? null,
          })
          .run();
      } else if (link.personId !== to) {
        // The row moves rather than being replaced, so the channel-side name it
        // carries survives a move the way it survives a reclaim.
        tx.update(channelMappings)
          .set({ personId: to })
          .where(eq(channelMappings.id, link.id))
          .run();
      }
      return { linked: true };
    });
  }

  private async mintId(displayName: string): Promise<string> {
    const base = generatePersonSlug(displayName);
    if (!base) return uuid();

    const existing = await this.db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.id, base));
    if (existing.length === 0) return base;

    const conflicts = await this.db
      .select({ id: persons.id })
      .from(persons)
      .where(like(persons.id, `${base}-%`));

    return nextAvailablePersonId(base, [base, ...conflicts.map((row) => row.id)]);
  }

  /**
   * Settle who may take each account, before any transaction opens, so a
   * refusal can name the holder. A dismissed account is released to whoever
   * names its sender; one a person holds is refused. The unique index still
   * backstops a rival claim landing between this read and the write.
   */
  private async resolveClaims(accounts: (Link & { displayName?: string })[]): Promise<Claim[]> {
    const claims: Claim[] = [];
    for (const account of accounts) {
      const held = this.holderOf(account);
      if (held) {
        throw new AccountHeldError({
          channel: account.channel,
          channelUserId: account.channelUserId,
          personId: held.personId,
          personName: held.personName,
        });
      }
      claims.push({
        channel: this.connectionKindOf(account.channel),
        channelUserId: account.channelUserId,
        // The name belongs to the channel, so a caller with none to offer
        // carries the dismissal's forward rather than clearing it.
        displayName: account.displayName ?? this.dismissalOf(account)?.displayName ?? null,
      });
    }
    return claims;
  }

  /** Take an account {@link resolveClaims} cleared for this person. */
  private writeClaim(exec: SqliteExec, personId: string, claim: Claim): void {
    this.releaseDismissals(exec, claim.channel, [claim.channelUserId]);
    exec
      .insert(channelMappings)
      .values({ id: uuid(), personId, ...claim })
      .run();
  }

  /** Delete the dismissals of these addresses. Links are never touched, so an
   *  account a person holds stays placed and the unique index turns an attempt
   *  to take it into a rollback rather than a silent theft. */
  private releaseDismissals(
    exec: SqliteExec,
    channel: string,
    addresses: readonly string[],
  ): number {
    if (addresses.length === 0) return 0;
    channel = this.connectionKindOf(channel);
    return exec
      .delete(dismissedAccounts)
      .where(
        and(
          eq(dismissedAccounts.channel, channel),
          inArray(dismissedAccounts.channelUserId, [...addresses]),
        ),
      )
      .run().changes;
  }

  /** The person holding an account, or null when nobody does. The join loses
   *  nothing — every link references a person row. */
  private holderOf(account: Link, exec: Pick<DrizzleDb, "select"> = this.db): AccountHolder | null {
    const channel = this.connectionKindOf(account.channel);
    const row = exec
      .select({ personId: channelMappings.personId, personName: persons.displayName })
      .from(channelMappings)
      .innerJoin(persons, eq(channelMappings.personId, persons.id))
      .where(
        and(
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, account.channelUserId),
        ),
      )
      .get();
    return row ? { channel, channelUserId: account.channelUserId, ...row } : null;
  }

  /** The account's dismissal, or null when it is not dismissed. */
  private dismissalOf(account: Link, exec: Pick<DrizzleDb, "select"> = this.db): Dismissal | null {
    const channel = this.connectionKindOf(account.channel);
    return (
      exec
        .select()
        .from(dismissedAccounts)
        .where(
          and(
            eq(dismissedAccounts.channel, channel),
            eq(dismissedAccounts.channelUserId, account.channelUserId),
          ),
        )
        .get() ?? null
    );
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
