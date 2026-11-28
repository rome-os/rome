// Who said each message an agent reads: the person behind its account and
// their role, as Identity and Access answer. Vocabulary:
// docs/domains/participation.md#projection and docs/domains/access.md.

import type { Account } from "@rome-os/app-runtime";
import type { NamedMember } from "../access/application/members.js";
import type { PromptMessage, UnseenMessage } from "../agent/index.js";
import type { ContextLine, UnseenLine } from "../sessions/turn-links.js";

/** The member an account belongs to, as Access's `memberOfAccount` answers,
 *  or null when it belongs to nobody or its person has no role. */
export type MemberOfAccount = (account: Account) => Promise<NamedMember | null>;

/**
 * Who said a message from an account of `member`, as the agent reads it: the
 * person's name and role, such as "Ana Lopez, guardian", "ana@example.com,
 * member" or "not a member". An agent's account in the guardian's Rome Cloud
 * account is the guardian's, so it names the guardian. Never built from the
 * name the message showed, which the sender chose.
 */
export function whoIs(member: NamedMember | null): string {
  if (!member) return "not a member";
  return member.name ? `${member.name}, ${member.role}` : member.role;
}

/**
 * Who a message's sender is, as the agent reads it: {@link whoIs}'s answer.
 * Null for a message with no account, such as one of Rome's own.
 */
export function whoSaid(line: ContextLine, member: NamedMember | null): string | null {
  return line.account ? whoIs(member) : null;
}

/**
 * Turns the messages an agent reads into what it reads, each sender labelled
 * with who they are. Asked at every read, never stored on the message, so an
 * account added or a member removed shows from the next turn.
 */
export class SenderLabels {
  constructor(private readonly memberOf: MemberOfAccount) {}

  /** `lines` as the agent reads them, in the same order. */
  async read(lines: readonly ContextLine[]): Promise<PromptMessage[]> {
    const members = await this.membersOf(lines);
    return lines.map((line) => this.asRead(line, members));
  }

  /** The messages a session has not seen, and the messages they quote, as the
   *  agent reads them. */
  async readUnseen(lines: readonly UnseenLine[]): Promise<UnseenMessage[]> {
    const members = await this.membersOf(
      lines.flatMap((line) => (line.quoted ? [line, line.quoted] : [line])),
    );
    return lines.map((line) => ({
      ...this.asRead(line, members),
      fromRome: line.fromRome,
      quoted: line.quoted && this.asRead(line.quoted, members),
      quotesOutside: line.quotesOutside,
    }));
  }

  private asRead(
    line: ContextLine,
    members: ReadonlyMap<string, NamedMember | null>,
  ): PromptMessage {
    const member = line.account ? (members.get(accountKey(line.account)) ?? null) : null;
    return {
      id: line.id,
      sender: line.senderName,
      who: whoSaid(line, member),
      text: line.text,
      at: line.at,
    };
  }

  /** The member behind each account among `lines`, asked once per account. */
  private async membersOf(lines: readonly ContextLine[]): Promise<Map<string, NamedMember | null>> {
    const accounts = new Map<string, Account>();
    for (const line of lines)
      if (line.account) accounts.set(accountKey(line.account), line.account);
    const answers = await Promise.all(
      [...accounts].map(async ([key, account]) => [key, await this.memberOf(account)] as const),
    );
    return new Map(answers);
  }
}

function accountKey(account: Account): string {
  return `${account.platform}\n${account.id}`;
}
