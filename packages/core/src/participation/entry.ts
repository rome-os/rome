// The check what someone says or presses on a connection passes before anything
// runs for it. Vocabulary: docs/domains/participation.md#entry.

/** Who said or pressed it, as their connection names them. */
export interface EntryAccount {
  platform: string;
  id: string;
}

export type Entry<Person = unknown> =
  | { kind: "entered"; person: Person }
  /** Nobody holds the account. */
  | { kind: "unknown" }
  /** The account's person has no role, its connection could not verify it, or
   *  no answer could be had. */
  | { kind: "refused" };

/** Access's answer, asked once for each message, command and press. */
export interface EntryPort<Person = unknown> {
  /** Never rejects. */
  enter(account: EntryAccount): Promise<Entry<Person>>;
}
