// Who said each message an agent reads, as People answers "who is this".
// Vocabulary: docs/domains/participation.md#projection and
// docs/domains/people.md#who-is-this.

import type { Account } from "@rome-os/app-runtime";
import type { PromptMessage, UnseenMessage } from "../agent/index.js";
import type { BondLevel, Person, PeopleRepository } from "../db/repositories/people.js";
import type { ContextLine, UnseenLine } from "../sessions/turn-links.js";

const BOND_LEVEL_WORDS: Record<BondLevel, string> = {
  guardian: "guardian",
  "inner-circle": "inner circle",
  acquaintance: "acquaintance",
  other: "other",
};

/**
 * Who a message's sender is, as the agent reads it: the person and bond level
 * People says is behind the account, or "not linked" when People answers
 * nobody. `person` is that answer for `line.account`. Null for a message with
 * no account, such as one of Rome's own. Never built from the name the
 * message showed, which the sender chose.
 */
export function whoSaid(line: ContextLine, person: Person | null): string | null {
  const { account } = line;
  if (!account) return null;
  if (!person) return "not linked";
  const bond = BOND_LEVEL_WORDS[person.bondLevel];
  const delegate = person.links.some(
    (link) => link.delegate && link.platform === account.platform && link.id === account.id,
  );
  return delegate
    ? `agent acting for ${person.displayName}, ${bond}`
    : `${person.displayName}, ${bond}`;
}

/**
 * Turns the messages an agent reads into what it reads, each sender labelled
 * with who they are. People is asked at every read, never stored on the
 * message, so a link the guardian makes or removes shows from the next turn.
 */
export class SenderLabels {
  constructor(private readonly people: Pick<PeopleRepository, "byAccount">) {}

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
