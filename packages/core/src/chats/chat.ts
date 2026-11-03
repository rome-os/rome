// The Chat aggregate. Vocabulary: docs/domains/chats.md#chat,
// docs/domains/chats.md#participant and docs/domains/chats.md#reply-rule.
//
// Every change to a chat is a method here, and each one checks its rules
// before it changes anything, so a refused call leaves the chat as it was.

import type { Account, StoredChatSettings } from "@rome-os/app-runtime";
import type { ChatKey } from "./place.js";

/** Whether a chat is a group or a direct message. Something about the chat,
 *  never part of its key. */
export type ChatKind = "dm" | "group";

/** An account in a chat. `romes` marks one of Rome's own accounts. */
export interface Participant {
  readonly account: Account;
  readonly romes: boolean;
}

/**
 * When the agent of Rome's account in the chat is woken. Over today's storage
 * it is the chat's whole settings record, whose activation fields are the
 * rule proper; reply placement, the session reset and the routed agent travel
 * with it until each finds its own home.
 */
export type ReplyRule = StoredChatSettings;

/** Everything a chat holds, as its repository reads and writes it. */
export interface ChatState {
  readonly key: ChatKey;
  readonly kind: ChatKind;
  /** The platform's name for the chat, or null while it has given none. */
  readonly name: string | null;
  readonly participants: readonly Participant[];
  readonly replyRule: ReplyRule | null;
  readonly ended: boolean;
}

/** A call the chat's rules refuse. The chat is unchanged. */
export class ChatRefusal extends Error {
  override readonly name = "ChatRefusal";
}

/** Platforms where Rome is the platform, so a chat's reply rule is fixed at
 *  every message: the dashboard (`webchat`) and Rome Cloud (`agents`). */
const FIXED_RULE_PLATFORMS: ReadonlySet<string> = new Set(["webchat", "agents"]);

export function sameAccount(a: Account, b: Account): boolean {
  return a.platform === b.platform && a.id === b.id;
}

/**
 * A place on a platform, its participants, and the rule for when Rome's agent
 * there is woken. While a chat is live, at least one of Rome's accounts is in
 * it; it ends when the last one leaves. Its key and kind never change.
 *
 * One reply rule per chat for now, not one per of Rome's accounts in it: no
 * caller yet sets a rule for one account of several. The rule goes when the
 * last of Rome's accounts leaves, which ends the chat with it.
 */
export class Chat {
  private constructor(
    readonly key: ChatKey,
    readonly kind: ChatKind,
    private _name: string | null,
    private _participants: Participant[],
    private _replyRule: ReplyRule | null,
    private _ended: boolean,
  ) {}

  /** A chat whose first message has reached Rome through `via`, one of
   *  Rome's accounts, which is its first participant. Refuses an account on
   *  another platform than the key's. */
  static start(key: ChatKey, kind: ChatKind, via: Account, name: string | null): Chat {
    if (via.platform !== key.platform) {
      throw new ChatRefusal(
        `Rome's account on ${via.platform} cannot start a chat on ${key.platform}`,
      );
    }
    return new Chat(key, kind, name, [{ account: via, romes: true }], null, false);
  }

  /** A chat as its repository stored it. Throws on a state the rules forbid,
   *  since a live chat with none of Rome's accounts in it is a broken record. */
  static restore(state: ChatState): Chat {
    const participants = distinct(state.key, state.participants);
    if (!state.ended && !participants.some((p) => p.romes)) {
      throw new Error(
        `Chat ${state.key.platform}:${state.key.id} is live with none of Rome's accounts in it`,
      );
    }
    return new Chat(state.key, state.kind, state.name, participants, state.replyRule, state.ended);
  }

  get name(): string | null {
    return this._name;
  }

  get participants(): readonly Participant[] {
    return this._participants;
  }

  get replyRule(): ReplyRule | null {
    return this._replyRule;
  }

  get ended(): boolean {
    return this._ended;
  }

  state(): ChatState {
    return {
      key: this.key,
      kind: this.kind,
      name: this._name,
      participants: this._participants,
      replyRule: this._replyRule,
      ended: this._ended,
    };
  }

  /** Whether `account` is one of Rome's accounts in this chat. */
  isRomes(account: Account): boolean {
    return this._participants.some((p) => p.romes && sameAccount(p.account, account));
  }

  /**
   * Replace the participants with the list the platform reports. Ends the chat
   * when none of Rome's accounts is left in it. Refuses an account on another
   * platform. An account listed twice is one participant, and one of Rome's
   * when either listing marks it so.
   */
  setParticipants(participants: readonly Participant[]): void {
    this.assertLive();
    const next = distinct(this.key, participants);
    if (!next.some((p) => p.romes)) {
      this._participants = next;
      this.end();
      return;
    }
    this._participants = next;
  }

  /**
   * Set when the agent of `romeAccount` is woken, or clear the rule with null
   * so the defaults apply. Refuses an account that is not one of Rome's in the
   * chat, and a rule that sets when to wake on a platform where that is fixed.
   * What travels with the rule, such as the session reset, may still change.
   */
  setReplyRule(romeAccount: Account, rule: ReplyRule | null): void {
    this.assertLive();
    if (
      FIXED_RULE_PLATFORMS.has(this.key.platform) &&
      (rule?.overrides.enabled !== undefined || rule?.overrides.activation !== undefined)
    ) {
      throw new ChatRefusal(`A chat on ${this.key.platform} replies to every message`);
    }
    if (!this.isRomes(romeAccount)) {
      throw new ChatRefusal(
        `${romeAccount.platform}:${romeAccount.id} is not one of Rome's accounts in this chat`,
      );
    }
    this._replyRule = rule;
  }

  /** Take the platform's current name for the chat. */
  rename(name: string): void {
    this.assertLive();
    this._name = name;
  }

  /** Mark the chat ended. Its repository removes it, with its messages. An
   *  ended chat refuses every other operation. */
  end(): void {
    this.assertLive();
    this._ended = true;
    this._replyRule = null;
  }

  private assertLive(): void {
    if (this._ended) {
      throw new ChatRefusal(`Chat ${this.key.platform}:${this.key.id} has ended`);
    }
  }
}

function distinct(key: ChatKey, participants: readonly Participant[]): Participant[] {
  const result: Participant[] = [];
  for (const participant of participants) {
    if (participant.account.platform !== key.platform) {
      throw new ChatRefusal(
        `${participant.account.platform}:${participant.account.id} cannot be in a chat on ${key.platform}`,
      );
    }
    const index = result.findIndex((p) => sameAccount(p.account, participant.account));
    if (index === -1) {
      result.push(participant);
    } else if (participant.romes && !result[index]!.romes) {
      result[index] = participant;
    }
  }
  return result;
}
