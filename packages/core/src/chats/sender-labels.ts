// Who said each message an agent reads, as People answers "who is this".
// Vocabulary: docs/domains/participation.md#projection and
// docs/domains/people.md#who-is-this.

import type { Account, SaidSender } from "@rome-os/app-runtime";
import type { PromptMessage, UnseenMessage } from "../agent/index.js";
import type {
  BondLevel,
  Person,
  PeopleRepository,
} from "../people/infrastructure/drizzle-people-repository.js";
import type { ContextLine, UnseenLine } from "../sessions/turn-links.js";

const BOND_LEVEL_WORDS: Record<BondLevel, string> = {
  guardian: "guardian",
  "inner-circle": "inner circle",
  acquaintance: "acquaintance",
  other: "other",
};

/**
 * Who said a message from `account`: the person People says is behind it,
 * with their bond level, or nobody, and whether the account is that person's
 * agent (a delegate link). `person` is People's answer for `account`. Never
 * built from the name the message showed, which the sender chose.
 */
export function whoIs(account: Account, person: Person | null): SaidSender {
  if (!person) return { person: null, delegate: false, label: "not linked" };
  const bond = BOND_LEVEL_WORDS[person.bondLevel];
  const delegate = person.links.some(
    (link) => link.delegate && link.platform === account.platform && link.id === account.id,
  );
  return {
    person: { id: person.id, name: person.displayName, bondLevel: person.bondLevel },
    delegate,
    label: delegate
      ? `agent acting for ${person.displayName}, ${bond}`
      : `${person.displayName}, ${bond}`,
  };
}

/**
 * Who a message's sender is, as the agent reads it: {@link whoIs}'s label.
 * Null for a message with no account, such as one of Rome's own.
 */
export function whoSaid(line: ContextLine, person: Person | null): string | null {
  return line.account ? whoIs(line.account, person).label : null;
}

/**
 * Turns the messages an agent reads into what it reads, each sender labelled
 * with who they are. People is asked at every read, never stored on the
 * message, so a link the guardian makes or removes shows from the next turn.
 */
export class SenderLabels {
  constructor(private readonly people: Pick<PeopleRepository, "byAccount">) {}

  /** Who said a message from `account`, asking People now. */
  async sender(account: Account): Promise<SaidSender> {
    return whoIs(account, await this.people.byAccount(account));
  }

  /** `lines` as the agent reads them, in the same order. */
  async read(lines: readonly ContextLine[]): Promise<PromptMessage[]> {
    const persons = await this.personsOf(lines);
    return lines.map((line) => this.asRead(line, persons));
  }

  /** The messages a session has not seen, and the messages they quote, as the
   *  agent reads them. */
  async readUnseen(lines: readonly UnseenLine[]): Promise<UnseenMessage[]> {
    const persons = await this.personsOf(
      lines.flatMap((line) => (line.quoted ? [line, line.quoted] : [line])),
    );
    return lines.map((line) => ({
      ...this.asRead(line, persons),
      fromRome: line.fromRome,
      quoted: line.quoted && this.asRead(line.quoted, persons),
      quotesOutside: line.quotesOutside,
    }));
  }

  private asRead(line: ContextLine, persons: ReadonlyMap<string, Person | null>): PromptMessage {
    const person = line.account ? (persons.get(accountKey(line.account)) ?? null) : null;
    return {
      id: line.id,
      sender: line.senderName,
      who: whoSaid(line, person),
      text: line.text,
      at: line.at,
    };
  }

  /** People's answer for each account among `lines`, asked once per account. */
  private async personsOf(lines: readonly ContextLine[]): Promise<Map<string, Person | null>> {
    const accounts = new Map<string, Account>();
    for (const line of lines)
      if (line.account) accounts.set(accountKey(line.account), line.account);
    const answers = await Promise.all(
      [...accounts].map(
        async ([key, account]) => [key, await this.people.byAccount(account)] as const,
      ),
    );
    return new Map(answers);
  }
}

function accountKey(account: Account): string {
  return `${account.platform}\n${account.id}`;
}
