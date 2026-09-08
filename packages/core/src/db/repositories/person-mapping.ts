import { eq, and, sql, ne, like, inArray, exists, notExists } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { persons, channelMappings } from "../schema.js";
import type { DrizzleDb, DrizzleTx, SqliteExec } from "../index.js";
import { STRANGER_PERSON_ID } from "../../constants.js";
import {
  generatePersonSlug,
  nextAvailablePersonId,
  protectedPersonReason,
} from "@rome/api-types/persons";

// Re-exported so existing importers keep their path. The derivation itself
// lives in the shared package because the dashboard's mock backend has to
// predict the ids this repository mints.
export { generatePersonSlug };

/** An account cleared for a person to take, with the channel-side name that
 *  travels with it. */
interface ChannelClaim {
  channel: string;
  channelUserId: string;
  displayName: string | null;
}

/** An account a person already holds, and the person holding it. */
export interface AccountHolder {
  channel: string;
  channelUserId: string;
  personId: string;
  personName: string;
}

/**
 * Thrown when a write would take an account a real person already holds.
 *
 * Carries the holder rather than only reporting that there is one: every
 * caller has to name them, because the guardian decides whether to move the
 * account and cannot decide without knowing whose it is.
 *
 * A dismissed account has no holder. Dismissal files an account under the
 * stranger sentinel, which is structure rather than a person, so naming its
 * sender releases it with nothing to refuse.
 */
export class AccountHeldError extends Error {
  constructor(readonly holder: AccountHolder) {
    super(
      `Account ${holder.channel}:${holder.channelUserId} already belongs to person "${holder.personId}"`,
    );
    this.name = "AccountHeldError";
  }
}

/** What a {@link PersonMappingRepository.linkAccount} attempt did: took the
 *  account, or refused it and named whoever holds it — null where nobody does,
 *  which is what a stale `transferFrom` runs into.
 *
 *  A result rather than an {@link AccountHeldError}: a refused link is the
 *  ordinary answer to a stale page, not the exceptional one it is for a create,
 *  where the account is the reason the person was being written at all. */
export type LinkAccountResult = { linked: true } | { linked: false; holder: AccountHolder | null };

/** What a {@link PersonMappingRepository.mergePersons} attempt did: absorbed
 *  the source, links and all, or refused and said which rule stopped it. The
 *  reason rather than the sentence, so the wording a caller answers with stays
 *  the contract's rather than this table's. */
export type MergePersonsResult =
  | { merged: true; links: number }
  | { merged: false; reason: MergeRefusal };

/** Why a merge did not happen. "sentinel-*" and "unknown-*" both describe an
 *  id that names nobody a caller may address, and "guardian-source" a person
 *  who exists and stays. */
export type MergeRefusal =
  | "same-person"
  | "unknown-target"
  | "unknown-source"
  | "guardian-source"
  | "sentinel-source"
  | "sentinel-target";

export interface NewPersonData {
  displayName: string;
  bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
  profilePath?: string;
  approved?: boolean;
}

/**
 * The people the guardian knows and which accounts belong to each of them.
 *
 * The repository and its verbs keep the `channel_mappings` name: a channel
 * mapping is a [link](docs/concepts/people.md#link), and `channelUserId` is the
 * account's own [address](docs/concepts/people.md#address), but the table, the
 * columns, and the `PersonMappingRepository` interface `@rome-os/app-runtime`
 * publishes all carry the older names, so renaming here would leave two names
 * for one thing rather than one.
 */
export class PersonMappingRepository {
  constructor(private db: DrizzleDb) {}

  private async generatePersonId(displayName: string): Promise<string> {
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

  async findByChannelUser(channel: string, channelUserId: string) {
    const rows = await this.db
      .select({
        person: persons,
        mapping: channelMappings,
      })
      .from(channelMappings)
      .innerJoin(persons, eq(channelMappings.personId, persons.id))
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );

    if (rows.length === 0) return null;

    const person = rows[0].person;
    const allMappings = await this.db
      .select()
      .from(channelMappings)
      .where(eq(channelMappings.personId, person.id));

    return {
      ...person,
      channelMappings: allMappings.map((m) => ({
        channel: m.channel,
        channelUserId: m.channelUserId,
      })),
    };
  }

  async findById(id: string) {
    const rows = await this.db.select().from(persons).where(eq(persons.id, id));
    if (rows.length === 0) return null;

    const person = rows[0];
    const mappings = await this.db
      .select()
      .from(channelMappings)
      .where(eq(channelMappings.personId, id));

    return {
      ...person,
      channelMappings: mappings.map((m) => ({
        channel: m.channel,
        channelUserId: m.channelUserId,
      })),
    };
  }

  async findByName(displayName: string) {
    const rows = await this.db.select().from(persons).where(eq(persons.displayName, displayName));

    const results = [];
    for (const person of rows) {
      const mappings = await this.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.personId, person.id));
      results.push({
        ...person,
        channelMappings: mappings.map((m) => ({
          channel: m.channel,
          channelUserId: m.channelUserId,
        })),
      });
    }
    return results;
  }

  async findByNameFuzzy(displayName: string) {
    const rows = await this.db
      .select()
      .from(persons)
      .where(
        and(
          sql`LOWER(${persons.displayName}) = LOWER(${displayName})`,
          ne(persons.id, STRANGER_PERSON_ID),
        ),
      );

    if (rows.length === 0) return null;

    const person = rows[0];
    const mappings = await this.db
      .select()
      .from(channelMappings)
      .where(eq(channelMappings.personId, person.id));

    return {
      ...person,
      channelMappings: mappings.map((m) => ({
        channel: m.channel,
        channelUserId: m.channelUserId,
      })),
    };
  }

  async findByBondLevel(bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other") {
    const rows = await this.db.select().from(persons).where(eq(persons.bondLevel, bondLevel));

    const results = [];
    for (const person of rows) {
      const mappings = await this.db
        .select()
        .from(channelMappings)
        .where(eq(channelMappings.personId, person.id));
      results.push({
        ...person,
        channelMappings: mappings.map((m) => ({
          channel: m.channel,
          channelUserId: m.channelUserId,
        })),
      });
    }
    return results;
  }

  /**
   * Every person with their channel mappings, read as one statement.
   *
   * One statement rather than one per person, and not only to save the reads:
   * a mapping moving between two people mid-read would otherwise land under
   * both of them (or neither), because each person's mappings would arrive in
   * their own autocommit query. Every reader of this table assumes an account
   * has one owner.
   */
  async findAllWithMappings() {
    const rows = await this.db
      .select({ person: persons, mapping: channelMappings })
      .from(persons)
      .leftJoin(channelMappings, eq(channelMappings.personId, persons.id));

    const byPerson = new Map<
      string,
      typeof persons.$inferSelect & {
        channelMappings: { channel: string; channelUserId: string }[];
      }
    >();
    for (const row of rows) {
      let person = byPerson.get(row.person.id);
      if (!person) {
        person = { ...row.person, channelMappings: [] };
        byPerson.set(row.person.id, person);
      }
      if (row.mapping) {
        person.channelMappings.push({
          channel: row.mapping.channel,
          channelUserId: row.mapping.channelUserId,
        });
      }
    }
    return [...byPerson.values()];
  }

  /**
   * Create a person and claim their accounts, both or neither.
   *
   * An account filed under the stranger sentinel is a dismissal rather than a
   * placement, so naming its sender releases it. An account a real person
   * holds stays held: this throws {@link AccountHeldError} instead of stealing
   * it, because creating a person is not a re-point. The refusal is a
   * rollback, not a partial write — a person committed without their account
   * would be unreachable and permanent, since {@link findByName} would then
   * reject every retry as a duplicate of the wreckage.
   *
   * Whatever the caller names, all of it or none of it: the accounts are
   * settled together before the transaction opens, so one held account in a
   * list of five leaves the other four where they were.
   */
  async create(data: {
    displayName: string;
    bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
    profilePath?: string;
    approved?: boolean;
    channelMappings?: { channel: string; channelUserId: string }[];
  }) {
    const id = await this.generatePersonId(data.displayName);

    const claims = await this.resolveClaims(data.channelMappings ?? []);

    this.db.transaction((tx) => {
      this.writePerson(tx, id, data);
      for (const claim of claims) this.writeClaim(tx, id, claim);
    });

    return id;
  }

  /**
   * Settle who may take each account, before any transaction opens, so a
   * refusal can name the holder. An account filed under the stranger sentinel
   * is a dismissal rather than a placement, so it is released to whoever names
   * its sender; one a real person holds is refused. The unique index still
   * backstops a rival claim landing between this read and the write.
   */
  private async resolveClaims(
    mappings: { channel: string; channelUserId: string; displayName?: string }[],
  ): Promise<ChannelClaim[]> {
    const claims: ChannelClaim[] = [];
    for (const mapping of mappings) {
      const held = await this.findChannelMapping(mapping.channel, mapping.channelUserId);
      if (held && held.personId !== STRANGER_PERSON_ID) {
        throw new AccountHeldError({
          channel: mapping.channel,
          channelUserId: mapping.channelUserId,
          personId: held.personId,
          personName: held.personName,
        });
      }
      claims.push({
        channel: mapping.channel,
        channelUserId: mapping.channelUserId,
        // The name belongs to the channel, so a caller with none to offer
        // carries the dismissed row's forward rather than clearing it.
        displayName: mapping.displayName ?? held?.displayName ?? null,
      });
    }
    return claims;
  }

  /** Take an account {@link resolveClaims} cleared for this person. */
  private writeClaim(exec: SqliteExec, personId: string, claim: ChannelClaim): void {
    this.writeReleaseStrangerClaim(exec, claim.channel, claim.channelUserId);
    exec
      .insert(channelMappings)
      .values({ id: uuid(), personId, ...claim })
      .run();
  }

  /** The row holding an account and the name of the person holding it,
   *  or null when nobody holds it. The join loses nothing — every mapping
   *  references a person row. */
  private async findChannelMapping(channel: string, channelUserId: string) {
    const rows = await this.db
      .select({ mapping: channelMappings, personName: persons.displayName })
      .from(channelMappings)
      .innerJoin(persons, eq(channelMappings.personId, persons.id))
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );
    const row = rows[0];
    return row ? { ...row.mapping, personName: row.personName } : null;
  }

  /** Write helper for {@link createWithId}, taking an executor (see
   *  {@link writeChannelMapping}). */
  writePerson(exec: SqliteExec, id: string, data: NewPersonData): string {
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
    return id;
  }

  async createWithId(id: string, data: NewPersonData) {
    return this.writePerson(this.db, id, data);
  }

  async updatePerson(
    id: string,
    data: Partial<{
      displayName: string;
      bondLevel: "guardian" | "inner-circle" | "acquaintance" | "other";
      profilePath: string | null;
      approved: boolean;
    }>,
  ) {
    await this.db.update(persons).set(data).where(eq(persons.id, id));
  }

  /** Enlist an unclaimed account in a caller's transaction without transferring a holder. */
  writeGuardianPairing(
    exec: DrizzleTx,
    channel: string,
    channelUserId: string,
    displayName: string,
  ): boolean {
    const holder = exec
      .select()
      .from(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      )
      .get();
    if (holder) return false;
    const guardian = exec.select().from(persons).where(eq(persons.bondLevel, "guardian")).get();
    if (!guardian) throw new Error("Guardian person is unavailable");
    this.writeChannelMapping(exec, guardian.id, channel, channelUserId, displayName);
    return true;
  }

  /** Write helper for {@link addChannelMapping}, taking an executor so it runs
   *  standalone (`this.db`) or enlisted in a caller's transaction (the terminal
   *  conferral maps the guardian in the SAME transaction as the credential
   *  write). */
  writeChannelMapping(
    exec: SqliteExec,
    personId: string,
    channel: string,
    channelUserId: string,
    displayName?: string,
  ): string {
    // Claiming an account is one statement, not a read followed by a write:
    // `(channel, channel_user_id)` is unique, so a second writer re-points the
    // mapping instead of adding a rival one, whatever order the two arrive in.
    const row = exec
      .insert(channelMappings)
      .values({ id: uuid(), personId, channel, channelUserId, displayName: displayName ?? null })
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
      // above. Returning the row's own id keeps the reported mapping real.
      .returning({ id: channelMappings.id })
      .get();
    return row.id;
  }

  /** Release an account that was only dismissed onto the stranger
   *  sentinel, so a caller naming its sender can claim it. Scoped to the
   *  sentinel deliberately: an account a real person holds is a placement, and
   *  leaving it in place lets the unique index turn an attempt to take it into
   *  a rollback rather than a silent theft. */
  writeReleaseStrangerClaim(exec: SqliteExec, channel: string, channelUserId: string): void {
    this.writeReleaseStrangerClaims(exec, channel, [channelUserId]);
  }

  /**
   * {@link writeReleaseStrangerClaim} over every address of one account, as
   * a single statement.
   *
   * One statement rather than one per address because they are one decision: a
   * channel can reach an account several ways, a dismissal is stored against
   * whichever one the guardian dismissed it by, and an undo that committed
   * some of them would leave the account still dismissed by the address it
   * missed.
   */
  writeReleaseStrangerClaims(
    exec: SqliteExec,
    channel: string,
    channelUserIds: readonly string[],
  ): number {
    if (channelUserIds.length === 0) return 0;
    return exec
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.channel, channel),
          inArray(channelMappings.channelUserId, [...channelUserIds]),
          eq(channelMappings.personId, STRANGER_PERSON_ID),
        ),
      )
      .run().changes;
  }

  /** {@link writeReleaseStrangerClaims}, standalone. How a restore undoes a
   *  dismissal: the sentinel's claim goes, and the account is nobody's again. */
  async releaseStrangerClaims(channel: string, channelUserIds: readonly string[]): Promise<number> {
    return this.writeReleaseStrangerClaims(this.db, channel, channelUserIds);
  }

  async addChannelMapping(
    personId: string,
    channel: string,
    channelUserId: string,
    displayName?: string,
  ) {
    return this.writeChannelMapping(this.db, personId, channel, channelUserId, displayName);
  }

  /** Write helper for {@link updateChannelUserId}, taking an executor (see
   *  {@link writeChannelMapping}). Returns whether the account moved, so a
   *  caller that decided on `from` earlier can tell that it is gone. */
  writeChannelUserId(
    exec: SqliteExec,
    personId: string,
    channel: string,
    from: string,
    to: string,
  ): boolean {
    // The row this call re-points, as a subquery so the guard runs inside the
    // caller's transaction rather than as a read before it (see
    // {@link writeDeleteGuardianChannelMappings}).
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

    // A rival holding `to` yields it, which is where {@link writeChannelMapping}'s
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
   * Repoint one of a person's accounts onto a new identifier, leaving
   * their other accounts on that channel alone. Used to heal a stale guardian
   * self JID (e.g. a device-suffixed WhatsApp id captured before
   * canonicalization) onto its canonical form on reconnect.
   *
   * Takes `to` from whoever else holds it, on the same terms as
   * {@link writeChannelMapping}: this is the channel reporting the identifier
   * its account answers to now, so a rival claim on it is the stale one.
   * Returns false when the person does not hold `from`, having moved nothing.
   */
  async updateChannelUserId(personId: string, channel: string, from: string, to: string) {
    return this.writeChannelUserId(this.db, personId, channel, from, to);
  }

  async deleteChannelMapping(channel: string, channelUserId: string) {
    await this.db
      .delete(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), eq(channelMappings.channelUserId, channelUserId)),
      );
  }

  /**
   * Remove only guardian accounts for a channel after its Talk grant is
   * explicitly disconnected. Other people mappings remain curated data, and
   * transient transport faults never call this path.
   */
  async deleteGuardianChannelMappings(channel: string): Promise<void> {
    this.writeDeleteGuardianChannelMappings(this.db, channel);
  }

  /**
   * Synchronous form of {@link deleteGuardianChannelMappings} for enlistment in
   * a better-sqlite3 transaction (e.g. connection teardown), so the guardian
   * mapping cleanup commits atomically with the connection/grant deletion rather
   * than as a separate best-effort write that can strand the mapping on failure.
   * The guardian-id lookup is inlined as a subquery, so nothing executes outside
   * `exec`.
   */
  writeDeleteGuardianChannelMappings(exec: SqliteExec, channel: string): void {
    const guardianIds = this.db
      .select({ id: persons.id })
      .from(persons)
      .where(eq(persons.bondLevel, "guardian"));

    exec
      .delete(channelMappings)
      .where(
        and(eq(channelMappings.channel, channel), inArray(channelMappings.personId, guardianIds)),
      )
      .run();
  }

  /**
   * Link an account to a person, if it is still where the caller last saw it.
   *
   * `transferFrom` is the owner the caller is taking the account from, and it
   * has to hold the account at the moment of the write. Omitted, the caller is
   * claiming an account they believe nobody holds — an unlinked one, one only
   * dismissed onto the sentinel, or one this person already holds, which is the
   * same request arriving twice. Every other case refuses and names the holder.
   *
   * The read and the move are one transaction, so of two callers working from
   * the same page exactly one lands the account: the loser's expected owner is
   * no longer the owner by the time its own transaction reads, and it is
   * refused rather than overwriting a transfer it never saw.
   */
  async linkAccount(params: {
    personId: string;
    channel: string;
    channelUserId: string;
    transferFrom?: string | null;
  }): Promise<LinkAccountResult> {
    const { personId, channel, channelUserId } = params;
    const expected = params.transferFrom ?? null;

    return this.db.transaction((tx): LinkAccountResult => {
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

      // A dismissal is a link onto the sentinel rather than a placement, so it
      // holds the account against nobody: naming its sender takes it back, on
      // the same terms as {@link resolveClaims}.
      const holder: AccountHolder | null =
        link && link.personId !== STRANGER_PERSON_ID
          ? { channel, channelUserId, personId: link.personId, personName: link.personName }
          : null;

      const swapped =
        expected === null
          ? holder === null || holder.personId === personId
          : holder?.personId === expected;
      if (!swapped) return { linked: false, holder };

      if (link == null) {
        // The channel's name for the account is not this caller's to supply —
        // a link names an account, and what to call it comes from the provider
        // directory at read time.
        tx.insert(channelMappings)
          .values({ id: uuid(), personId, channel, channelUserId, displayName: null })
          .run();
      } else if (link.personId !== personId) {
        // The row moves rather than being replaced, so the channel-side name it
        // carries survives a transfer the way it survives a reclaim.
        tx.update(channelMappings).set({ personId }).where(eq(channelMappings.id, link.id)).run();
      }
      return { linked: true };
    });
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
   * channel-side name across the way a transfer does. Nothing can collide on
   * the unique index: an account carries at most one link, so no account is
   * held by both people to begin with.
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
  async mergePersons(into: string, from: string): Promise<MergePersonsResult> {
    return this.db.transaction((tx): MergePersonsResult => {
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
      // The guardian anchors the ladder and the sentinel holds every
      // dismissal, so neither may be merged away. The sentinel is refused as a
      // target too: it is structure rather than someone a duplicate belongs
      // to, and absorbing a person into it would read every account they hold
      // as dismissed.
      const sourceIsStructure = protectedPersonReason(source);
      if (sourceIsStructure) {
        return {
          merged: false,
          reason: sourceIsStructure === "guardian" ? "guardian-source" : "sentinel-source",
        };
      }
      if (protectedPersonReason(target) === "stranger-sentinel") {
        return { merged: false, reason: "sentinel-target" };
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

  /** Drop one person's link to an account, leaving the account itself and
   *  every other link they hold alone. Reports whether the link was theirs to
   *  drop, which is the only way a caller can tell an unlink from a no-op. */
  async unlinkAccount(personId: string, channel: string, channelUserId: string): Promise<boolean> {
    const result = this.db
      .delete(channelMappings)
      .where(
        and(
          eq(channelMappings.personId, personId),
          eq(channelMappings.channel, channel),
          eq(channelMappings.channelUserId, channelUserId),
        ),
      )
      .run();
    return result.changes > 0;
  }
}

export function createPersonMappingRepository(db: DrizzleDb) {
  return new PersonMappingRepository(db);
}
