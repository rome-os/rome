// People's write port: the Person aggregate, loaded and saved whole with its
// links, and the account verbs that move a link between persons. Every People
// feature changes people through it. Vocabulary: docs/domains/people.md.

import type { BondLevel } from "./person.js";
import type { SqliteExec } from "../../db/index.js";
import type {
  DeleteResult,
  Dismissal,
  Link,
  LinkResult,
  MergeResult,
  NewPerson,
  Person,
  PersonChanges,
} from "./person.js";

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
export interface PeopleRepository {
  /** The person `id` names, or null. */
  byId(id: string): Promise<Person | null>;
  /**
   * Who is this: the person the account is linked to, or null. An account is
   * one link whichever of Rome's accounts met it, so a Telegram sender heard by
   * the bot and by the signed-in user is one person. Feishu's open_id is issued
   * per app, so a sender on a second Feishu app is a second account there.
   */
  byAccount(account: Link): Promise<Person | null>;
  /** Every person named exactly `displayName`. */
  byName(displayName: string): Promise<Person[]>;
  /** The first person named `displayName` in any case. */
  byNameIgnoringCase(displayName: string): Promise<Person | null>;
  byBondLevel(bondLevel: BondLevel): Promise<Person[]>;
  /**
   * Every person with their links, read as one statement.
   *
   * One statement rather than one per person, and not only to save the reads:
   * a link moving between two people mid-read would otherwise land under both
   * of them (or neither), because each person's links would arrive in their
   * own autocommit query. Every reader of this table assumes an account has
   * one owner.
   */
  all(): Promise<Person[]>;
  /** Every dismissed account. */
  dismissals(): Promise<Dismissal[]>;
  /** Whether the guardian dismissed the account. Who is this answers nobody
   *  for it, the same as for a stranger. */
  isDismissed(account: Link): Promise<boolean>;
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
  create(
    data: NewPerson & {
      links?: Link[];
    },
  ): Promise<string>;
  /** Create a person under an id the caller chose, with no links. */
  createWithId(id: string, data: NewPerson): Promise<string>;
  update(id: string, changes: PersonChanges): Promise<void>;
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
  merge(into: string, from: string): Promise<MergeResult>;
  /**
   * Delete a person and every link they hold, so their accounts are strangers
   * again (docs/domains/people.md#person). Nothing is dismissed on the way: the
   * guardian deleted a person, not a decision about each account.
   *
   * The links and the person go in one transaction, so no reader sees links
   * onto a person who is gone. The guardian anchors the ladder and is refused.
   */
  delete(personId: string): Promise<DeleteResult>;
  /**
   * Link an account nobody holds to `personId`.
   *
   * Claims a stranger, a dismissed account, or one this person already holds,
   * which is the same request arriving twice. An account another person holds
   * is refused and its holder named: taking it is {@link move}, the guardian's
   * explicit act.
   */
  link(account: Link, personId: string): Promise<LinkResult>;
  /**
   * Move an account from `from` to `to`, if `from` still holds it.
   *
   * The read and the move are one transaction, so of two callers working from
   * the same page exactly one lands the account: the loser's expected owner is
   * no longer the owner by the time its own transaction reads, and it is
   * refused rather than overwriting a move it never saw.
   */
  move(account: Link, from: string, to: string): Promise<LinkResult>;
  /**
   * Dismiss an account nobody holds. Dismissing an account already dismissed
   * is the same request arriving twice, and lands.
   *
   * Decided on the same terms as {@link link}, in one transaction: an account a
   * person holds is refused and its holder named, rather than its link
   * dropped and the person lost.
   */
  dismiss(account: Link): Promise<LinkResult>;
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
  restore(platform: string, addresses: readonly string[]): Promise<number>;
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
  linkStated(account: Link, personId: string, exec?: SqliteExec): string;
  /**
   * Link an agent's account to the person behind the agent, because a
   * platform says the agent is theirs, as a
   * [delegate link](docs/domains/people.md#delegate-link). Rome Cloud says so
   * for the guardian's own agents.
   *
   * Claims on the same terms as {@link linkStated}, and marks the link a
   * delegate whether it was new or re-pointed. Returns the link row's id.
   */
  linkDelegate(account: Link, personId: string): string;
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
  readdress(personId: string, account: Link, to: string, exec?: SqliteExec): boolean;
  /**
   * Drop the account's link. Named `from`, only that person's link goes, and
   * the result reports whether it was theirs to drop, which is the only way a
   * caller can tell an unlink from a no-op. Unnamed, whoever holds it loses
   * it. Either way the account becomes a stranger.
   */
  unlink(account: Link, from?: string): Promise<boolean>;
}
