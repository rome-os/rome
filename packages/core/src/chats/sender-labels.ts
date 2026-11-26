// Who said each message an agent reads: the person behind its account and
// their role, as Identity and Access answer. Vocabulary:
// docs/domains/participation.md#projection and docs/domains/access.md.

import type { Account, BondLevel, SaidSender } from "@rome-os/app-runtime";
import type { Role } from "../access/access.js";
import { type MemberContext, ROME_CLOUD_EMAIL_PLATFORM } from "../access/application/members.js";
import type { PromptMessage, UnseenMessage } from "../agent/index.js";
import type { ContextLine, UnseenLine } from "../sessions/turn-links.js";

/** The bond level a published {@link SaidSender} carries for each role: the
 *  guardian's own, and for a member the lowest, which grants the least
 *  wherever a bond level is read. */
const BOND_LEVEL_OF: Record<Role, BondLevel> = { guardian: "guardian", member: "other" };

/** The person an account belongs to, when they have a role. */
export interface AccountHolder {
  id: string;
  /** Their name, or their Rome Cloud email when Identity has no name. Null
   *  when it has neither. */
  name: string | null;
  role: Role;
}

/** Who holds an account, asked of Identity and Access. */
export interface AccountHolders {
  /** The person `account` belongs to and their role, or null when it belongs
   *  to nobody or its person has no role. */
  byAccount(account: Account): Promise<AccountHolder | null>;
}

/** {@link AccountHolders} answered by Identity and Access. */
export function accountHolders({ identity, access }: MemberContext): AccountHolders {
  return {
    async byAccount(account) {
      const person = await identity.personOf({ platform: account.platform, accountId: account.id });
      const role = person && (await access.roleOf(person.id));
      if (!person || !role) return null;
      const signIn = person.name
        ? undefined
        : (await identity.accountsOf(person.id)).find(
            (each) => each.platform === ROME_CLOUD_EMAIL_PLATFORM,
          );
      return { id: person.id, name: person.name ?? signIn?.accountId ?? null, role };
    },
  };
}

/**
 * Who said a message from an account `holder` holds: the person and their
 * role, or nobody. An agent's account in the guardian's Rome Cloud account is
 * the guardian's, so it names the guardian. Never built from the name the
 * message showed, which the sender chose.
 */
export function whoIs(holder: AccountHolder | null): SaidSender {
  if (!holder) return { person: null, delegate: false, label: "not linked" };
  return {
    person: {
      id: holder.id,
      name: holder.name ?? holder.role,
      bondLevel: BOND_LEVEL_OF[holder.role],
    },
    delegate: false,
    label: holder.name ? `${holder.name}, ${holder.role}` : holder.role,
  };
}

/**
 * Who a message's sender is, as the agent reads it: {@link whoIs}'s label.
 * Null for a message with no account, such as one of Rome's own.
 */
export function whoSaid(line: ContextLine, holder: AccountHolder | null): string | null {
  return line.account ? whoIs(holder).label : null;
}

/**
 * Turns the messages an agent reads into what it reads, each sender labelled
 * with who they are. Asked at every read, never stored on the message, so an
 * account added or a member removed shows from the next turn.
 */
export class SenderLabels {
  constructor(private readonly holders: AccountHolders) {}

  /** Who said a message from `account`, asking now. */
  async sender(account: Account): Promise<SaidSender> {
    return whoIs(await this.holders.byAccount(account));
  }

  /** `lines` as the agent reads them, in the same order. */
  async read(lines: readonly ContextLine[]): Promise<PromptMessage[]> {
    const holders = await this.holdersOf(lines);
    return lines.map((line) => this.asRead(line, holders));
  }

  /** The messages a session has not seen, and the messages they quote, as the
   *  agent reads them. */
  async readUnseen(lines: readonly UnseenLine[]): Promise<UnseenMessage[]> {
    const holders = await this.holdersOf(
      lines.flatMap((line) => (line.quoted ? [line, line.quoted] : [line])),
    );
    return lines.map((line) => ({
      ...this.asRead(line, holders),
      fromRome: line.fromRome,
      quoted: line.quoted && this.asRead(line.quoted, holders),
      quotesOutside: line.quotesOutside,
    }));
  }

  private asRead(
    line: ContextLine,
    holders: ReadonlyMap<string, AccountHolder | null>,
  ): PromptMessage {
    const holder = line.account ? (holders.get(accountKey(line.account)) ?? null) : null;
    return {
      id: line.id,
      sender: line.senderName,
      who: whoSaid(line, holder),
      text: line.text,
      at: line.at,
    };
  }

  /** Who holds each account among `lines`, asked once per account. */
  private async holdersOf(
    lines: readonly ContextLine[],
  ): Promise<Map<string, AccountHolder | null>> {
    const accounts = new Map<string, Account>();
    for (const line of lines)
      if (line.account) accounts.set(accountKey(line.account), line.account);
    const answers = await Promise.all(
      [...accounts].map(
        async ([key, account]) => [key, await this.holders.byAccount(account)] as const,
      ),
    );
    return new Map(answers);
  }
}

function accountKey(account: Account): string {
  return `${account.platform}\n${account.id}`;
}
