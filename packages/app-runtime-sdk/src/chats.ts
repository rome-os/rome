// Sending into chats by the refs Chats hands out. Vocabulary:
// docs/domains/chats.md#chat and docs/domains/chats.md#place.
//
// Served from `@rome-os/app-runtime/chats` because the root still exports the
// connection-keyed `ChatRef`. The root re-exports this module's refs once that
// one is removed.
//
// There are two levels. The resolvers turn an intent ("the direct message that
// reaches this account", "the Slack group named x") or a ref the app already
// holds into a {@link Chat} handle. Below them, {@link Chats.send} takes a
// {@link Place} Rome handed out and resolves nothing. Every handle's send is
// that one send. Nothing here takes a bare address or an account as a
// destination, so no destination is ever guessed into a direct message or a
// group.

import type { Account, OutgoingChatMessage } from "./index.js";

/**
 * A chat, as Chats names it: its platform and the id Chats gave it. The id is
 * local to this Rome install and carries no order. A ref stays valid across
 * reconnects, so an app may store it, such as in a routine's args, and send
 * to it later.
 */
export interface ChatRef {
  readonly platform: string;
  readonly id: number;
}

/**
 * A thread in a chat, named by the message it hangs off: `id` is that
 * message's {@link MessageRef.id}.
 */
export interface ThreadRef {
  readonly chat: ChatRef;
  readonly id: number;
}

/** Where a message is said and where a send goes: a chat, or a thread in one. */
export type Place = ChatRef | ThreadRef;

/** One message in a chat, by the id Chats gave it. */
export interface MessageRef {
  readonly chat: ChatRef;
  readonly id: number;
}

/**
 * What a send says. `replyTo` quotes a message of the same chat. On a
 * platform that answers a quote in a thread, the reply lands there, and
 * {@link Sent.thread} names it.
 */
export interface ChatMessage extends Omit<OutgoingChatMessage, "replyToMessageId" | "kind"> {
  replyTo?: MessageRef;
}

/** A message the platform took. Chats has recorded it before this answers. */
export interface Sent {
  readonly message: MessageRef;
  /** The platform's own id for the message, when it gave one. */
  readonly platformMessageId?: string;
  /** The thread the platform placed the message in, when it is in one. It can
   *  differ from the place sent to, as when a platform opens a thread for a
   *  reply. */
  readonly thread?: ThreadRef;
  readonly delivery: { readonly state: "sent"; readonly at: Date };
}

/**
 * Why a send or a resolver refused.
 *
 * - `chat_not_found`: no chat has that ref.
 * - `not_connected`: no Connection reaches the sender now.
 * - `sender_ambiguous`: several of Rome's accounts are in the chat and `as`
 *   names none of them.
 * - `sender_not_in_chat`: `as` names an account that is not in the chat.
 * - `unsupported`: the platform takes no sends from Rome there, such as a
 *   read-only inbox.
 * - `no_dm`: the platform opened no direct message with that account.
 * - `failed`: the platform refused the message. Nothing is recorded.
 */
export type SendErrorCode =
  | "chat_not_found"
  | "not_connected"
  | "sender_ambiguous"
  | "sender_not_in_chat"
  | "unsupported"
  | "no_dm"
  | "failed";

const SEND_ERROR_CODES: ReadonlySet<string> = new Set<SendErrorCode>([
  "chat_not_found",
  "not_connected",
  "sender_ambiguous",
  "sender_not_in_chat",
  "unsupported",
  "no_dm",
  "failed",
]);

/** The one way a send or a resolver fails. Only `failed` reached the
 *  platform. */
export class SendError extends Error {
  constructor(
    readonly code: SendErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SendError";
  }
}

/**
 * Whether `error` is a {@link SendError}. Matches by name and code rather than
 * by class, so it also holds for an error rebuilt on the far side of a
 * process boundary.
 */
export function isSendError(error: unknown): error is SendError {
  if (error instanceof SendError) return true;
  if (!(error instanceof Error) || error.name !== "SendError") return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && SEND_ERROR_CODES.has(code);
}

/** Who a send goes out as: one of Rome's accounts in the chat. Needed where
 *  several of Rome's accounts are, and in a dashboard chat. */
export interface SendOptions {
  as?: Account;
}

/** A chat to send into. A handle holds only its ref, so it is cheap to make
 *  and never goes stale. */
export interface Chat {
  readonly ref: ChatRef;
  send(out: ChatMessage, opts?: SendOptions): Promise<Sent>;
  /** The thread that hangs off `at`, a message of this chat or one of its
   *  threads. Throws when `at` is in another chat. */
  thread(at: MessageRef | ThreadRef): ChatThread;
}

/** A thread to send into. */
export interface ChatThread {
  readonly ref: ThreadRef;
  send(out: ChatMessage, opts?: SendOptions): Promise<Sent>;
}

/**
 * Chats as an app sends into them. An action receives it as `deps.chats`.
 */
export interface Chats {
  /**
   * The direct message that reaches `account`, opened on the platform when
   * there is none yet. Rejects with `no_dm` when the platform opens none, and
   * with `sender_ambiguous` when Rome holds several accounts on the platform
   * and `as` names none of them.
   */
  dm(account: Account, opts?: SendOptions): Promise<Chat>;
  /**
   * Every group on `platform` named `name` that one of Rome's accounts is in,
   * or only those `as` is in. Names are not unique, so the app picks among
   * several. Empty when none matches.
   */
  group(query: { platform: string; name: string; as?: Account }): Promise<Chat[]>;
  /** The chat `ref` names. Nothing is looked up until the handle sends. */
  byRef(ref: ChatRef): Chat;
  /**
   * Say `out` in `place` and answer once the platform took it. Rejects with a
   * {@link SendError}. No retry: a send that rejected with `failed` may be
   * sent again by the caller.
   */
  send(place: Place, out: ChatMessage, opts?: SendOptions): Promise<Sent>;
}

/** Whether `place` names a thread rather than a whole chat. */
export function isThreadRef(place: Place): place is ThreadRef {
  return "chat" in place;
}

/** The chat a place is in. */
export function chatOf(place: Place): ChatRef {
  return isThreadRef(place) ? place.chat : place;
}

/**
 * What a host answers for {@link Chats}: the calls that reach Chats. The
 * handles are built over it by {@link chatsOver}.
 */
export interface ChatsPort {
  send(place: Place, out: ChatMessage, opts?: SendOptions): Promise<Sent>;
  /** The ref of the direct message that reaches `account`. */
  dm(account: Account, opts?: SendOptions): Promise<ChatRef>;
  /** The refs of the groups that match, as {@link Chats.group} answers. */
  group(query: { platform: string; name: string; as?: Account }): Promise<ChatRef[]>;
}

/** {@link Chats} over a host's port, so every host hands out the same
 *  handles. */
export function chatsOver(port: ChatsPort): Chats {
  const send = (place: Place, out: ChatMessage, opts?: SendOptions) => port.send(place, out, opts);
  const thread = (chat: ChatRef, at: MessageRef | ThreadRef): ChatThread => {
    if (!sameChat(at.chat, chat)) {
      throw new Error(
        `A thread of ${chat.platform} chat ${chat.id} hangs off a message of that chat`,
      );
    }
    const ref: ThreadRef = { chat, id: at.id };
    return { ref, send: (out, opts) => send(ref, out, opts) };
  };
  const byRef = (ref: ChatRef): Chat => {
    const chat: ChatRef = { platform: ref.platform, id: ref.id };
    return {
      ref: chat,
      send: (out, opts) => send(chat, out, opts),
      thread: (at) => thread(chat, at),
    };
  };
  return {
    send,
    byRef,
    dm: async (account, opts) => byRef(await port.dm(account, opts)),
    group: async (query) => (await port.group(query)).map(byRef),
  };
}

function sameChat(a: ChatRef, b: ChatRef): boolean {
  return a.platform === b.platform && a.id === b.id;
}
