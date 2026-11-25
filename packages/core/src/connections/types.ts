// Connection caller and builder contracts. Vocabulary: docs/domains/connections.md.
//
// The runtime never inspects the contents of a credential's `material` (only
// the `expiresAt` envelope).

import type {
  ChannelMessage,
  ChatDescriptor,
  ChatId,
  ChatSettingsControl,
  MessageReceipt,
  OutgoingMessage,
  ChannelActivity,
  ChannelDirectMessaging,
  ChannelInboundMedia,
} from "@rome-os/app-runtime";
import type { AccountLink } from "@rome/api-types/account-agents";
import type { CredentialRejected, Disconnected } from "./errors.js";
import type { Message } from "./message.js";
import type { KindChatRules } from "../chat-settings/rules.js";

// ── Talk ─────────────────────────────────────────────────────────────────────
// A Connection's conversational surface, as its builder implements it
// (`Talker`). Only the channel ports (chats/connected-accounts/connection-ports.ts) reach it,
// through `Connection.withTalker`: apps reach channels through the channels
// service (actions) or a hook's `channels`. A talker delivers each message as
// a Connections `Message` (message.ts): the platform's facts, with no
// addressing. The ports turn it into the `ChannelMessage` apps receive.

/** The conversations a Connection can see, for conversation settings. */
export interface TalkDirectory {
  listConversations(input: {
    query?: string;
    cursor?: string;
    limit: number;
    includeTopics?: boolean;
    /** Also the threads the platform has archived, read from the platform.
     *  Implies `includeTopics`. A read that fails rejects. */
    includeArchived?: boolean;
  }): Promise<{ conversations: ChatDescriptor[]; nextCursor?: string }>;
}

/** What one read of a chat's history asks the platform for. Every bound is
 *  optional, and `limit` is already defaulted and capped. */
export interface TalkHistoryRead {
  /** Only messages said at or after this instant. */
  since?: Date;
  /** Only messages said at or before this instant. */
  until?: Date;
  /** Only messages said before the one with this platform id. */
  olderThan?: string;
  /** Only messages said after the one with this platform id: the `limit`
   *  right after it. Not with `olderThan`. */
  newerThan?: string;
  limit: number;
}

/** A chat's history as the platform keeps it, read live, so it holds
 *  messages Rome never heard. */
export interface TalkHistory {
  /** The chat's messages within the bounds, newest first, at most `limit`.
   *  Rejects with an error naming the chat when the account may not read it. */
  read(chatId: ChatId, read: TalkHistoryRead): Promise<ChannelMessage[]>;
}

/** Showing a chat that a message is being written: a typing indicator that
 *  lapses on its own after a few seconds, so a caller shows it again while the
 *  writing lasts. Core drives it by the same rule as the dashboard's typing
 *  dots (core/message-writing.ts). */
export interface TalkTyping {
  show(chatId: ChatId): Promise<void>;
}

/** Reacting to a message in a chat with an emoji, as the account. */
export interface TalkReactions {
  add(chatId: ChatId, messageId: string, emoji: string): Promise<void>;
  /** Takes the account's own reaction `emoji` off the message. One that is
   *  not there counts as taken off. */
  remove(chatId: ChatId, messageId: string, emoji: string): Promise<void>;
}

/** Messages to one account of the platform, which no other account reads. */
export interface TalkPrivateMessaging {
  /**
   * Delivers `text` to account `accountId` so that no other account can read
   * it. `chatId` is the chat the text answers, and `accountId` is the sender
   * id the kind reports on a delivered `Message`. The kind chooses where the
   * platform shows it. `options.replyToMessageId` names the message the text
   * answers, as `OutgoingMessage.replyToMessageId` does, so a kind that shows
   * the text in the chat shows it beside that message, in its thread when it
   * is in one. Resolves once the platform took the message, and rejects with
   * {@link PrivateMessageRefused} when the platform cannot show that account
   * a private message.
   */
  sendOnlyTo(
    chatId: ChatId,
    accountId: string,
    text: string,
    options?: PrivateMessageOptions,
  ): Promise<void>;
}

/** Where a private message sits among the chat's messages. */
export interface PrivateMessageOptions {
  /** The message the private message answers, one of the kind's message ids. */
  replyToMessageId?: string;
}

/** The platform cannot show the account a private message, as when it takes
 *  no direct messages or is not in the chat. Nothing was delivered. */
export class PrivateMessageRefused extends Error {
  readonly accountId: string;

  constructor(accountId: string, reason: string, options?: { cause?: unknown }) {
    super(`cannot send account ${accountId} a private message: ${reason}`, options);
    this.name = "PrivateMessageRefused";
    this.accountId = accountId;
  }
}

export interface TalkFeatureMap {
  inboundMedia: ChannelInboundMedia;
  activity: ChannelActivity;
  typing: TalkTyping;
  reactions: TalkReactions;
  directory: TalkDirectory;
  history: TalkHistory;
  /** A talker answers only `chatFor`. The channel port adds the deprecated
   *  `conversationFor` for callers. */
  directMessaging: Pick<ChannelDirectMessaging, "chatFor">;
  privateMessaging: TalkPrivateMessaging;
}

export type TalkFeatureName = keyof TalkFeatureMap;

/**
 * What a talker offers beyond sending and hearing, one optional field per
 * channel port it backs. An absent field is the declaration that the talker
 * does not offer it. The registry reads a field each time it is used, so a
 * getter defined on the talker literal stays live; spreading an object into the
 * talker reads its getters once.
 */
export type TalkFeatures = { [K in TalkFeatureName]?: TalkFeatureMap[K] };

export type ConnectionId = string; // opaque; minted with crypto.randomUUID()
export type GrantName = string;
export type Capability = "chat" | "act" | "watch";
export type SecretRecord = Record<string, string>;
/**
 * The non-secret half of a grant's grant outcome. Like SecretRecord, this
 * is deliberately opaque to the connection framework: each integration owns
 * the keys and value shapes it stores here.
 */
export type ProfileRecord = Record<string, unknown>;

// OutgoingMessage is the existing @rome-os/app-runtime shape (phase 2 collapses
// the message contract; do not invent a new shape now).
export type { ChatId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";

export interface OperationCall {
  operation: string;
  input?: unknown;
  /** Stable caller request id for an app-exposed write operation. */
  requestId?: string;
}
export type OperationResult = unknown;

export interface OperationDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /**
   * Opts this operation into the restricted App SDK broker. An absent value
   * keeps the operation Core-only.
   */
  appAccess?: {
    sideEffects: "read-only" | "write";
    /** Safe fields Core may show when a guardian approves this operation. A
     * write operation must declare this contract before an App can use it. */
    approvalPreview?: {
      summary: string;
      fields?: readonly {
        label: string;
        /** RFC 6901 JSON Pointer into the operation input. */
        inputPointer: string;
      }[];
    };
  };
}

/** Caller-facing Act handle. Outbound-only and synchronous. */
export interface Act {
  operations(): readonly OperationDescriptor[];
  invoke(call: OperationCall): Promise<OperationResult>;
}

export interface WatchEvent {
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

/** Caller-facing Watch handle. Fire-and-forget. */
export interface Watch {
  onEvent(handler: (event: WatchEvent) => void): void;
}

export type GrantState = "unauthorized" | "authorized" | "degraded";

/** Per-grant view of a connection's authority. */
export interface AuthState {
  grants(): Record<GrantName, GrantState>;
  revoke(grant: GrantName): Promise<void>;
}

/**
 * Grant ceremonies are not implemented for `grant`; this is the minimal
 * placeholder so `AuthScheme` compiles. Headless grants (tests, settings
 * import) never call it.
 */
export interface GuardianInteraction {
  prompt(form: {
    instructions?: string;
    fields: Array<{
      name: string;
      label: string;
      secret: boolean;
      format?: "line" | "multiline" | "file";
      options?: string[];
    }>;
  }): Promise<Record<string, string>>;
}

/**
 * The credential record both sub-problems agree on. Opaque to
 * the runtime except for `expiresAt`. `material` may be a read-through resolver
 * for externally-custodied credentials (Composio's CLI session file).
 */
export interface Credential {
  material: SecretRecord | (() => Promise<SecretRecord>);
  expiresAt: Date | "never";
}

/**
 * The framework's only universal identity surface. The ledger stores the opaque
 * `ProfileRecord`; the descriptor's `reviveProfile` re-parses a stored record
 * with the connection kind's own schema and maps the parsed plain data through the
 * connection kind's pure display function — the returned display object is what
 * satisfies this readonly interface. Kind-specific values that generic
 * readers can't render (scopes, workspace ids) stay on the parsed profile for
 * owner-side readers; they never widen this surface.
 */
export interface ProfileDisplay {
  readonly displayName: string | undefined;
  readonly handle: string | undefined;
  readonly email: string | undefined;
  readonly avatarUrl: string | undefined;
}

/** What a builder supplies per grant. */
export interface AuthScheme {
  obtain(interact: GuardianInteraction): Promise<Credential>;
  /**
   * the guardian-facing setup for this grant. When present,
   * the generic setup surface (`POST
   * /api/connections/:id/grants/:name/setup`) drives it: a server-owned
   * coroutine that prompts/shows/redirects and returns a terminal grant
   * (credential + profile + optional guardian mapping). Absent for grants with
   * no dashboard setup (headless imports, OAuth redirect routes). Kept
   * `unknown`-free by importing the setup type lazily to avoid a cycle: see
   * `./setup/types.ts`.
   */
  setup?: import("./setup/types.js").SetupFn;
  /** Renew WITHOUT the guardian, if the scheme can; "needs-fix" is the honest
   *  answer for pasted tokens and pairing sessions. Required, not optional. */
  renew(cred: Credential): Promise<Credential | "needs-fix">;
  /**
   * External-custody resolver. When a rehydrated credential persisted
   * as `{ kind: "external" }`, the registry re-wraps its live `material` with
   * this resolver — rehydration must never grant.
   */
  resolveExternal?: () => Promise<SecretRecord>;
}

/** A live capability can remain unlocked while its provider transport is
 * temporarily impaired (for example, WeChat's one-hour stale-session
 * cooldown). This is runtime-only health: it must not mutate grant custody or
 * remove the caller-facing capability handle. */
export interface CapabilityDegradation {
  reason: string;
  /** When the runtime expects to retry automatically, if known. */
  retryAt?: string;
}

export type CapabilityStatus =
  | { state: "unlocked"; degradation?: CapabilityDegradation }
  | { state: "needs-auth"; missingGrants: GrantName[] }
  | { state: "needs-subscription" }
  | { state: "unsupported" };

/**
 * Whether the platform accepts the connection's grant. A broken connection
 * keeps its account and that account's agent until the guardian gives access
 * again (docs/domains/connections.md).
 */
export type ConnectionState = "working" | "broken";

/** One connection kind, one grant, up to three capabilities. */
export interface Connection {
  readonly id: ConnectionId;
  readonly connectionKind: string;
  readonly label: string;
  readonly auth: AuthState;
  /**
   * Broken when the grant is degraded, working when it is authorized. Null
   * while it is unauthorized: a disconnect ends the connection, so only one
   * whose removal failed, or one not yet granted, is neither.
   */
  state(): ConnectionState | null;
  /** Discovery with reasons — drives the dashboard and connect hints. */
  status(): Record<Capability, CapabilityStatus>;
  /** Whether `cap` is built and live now. `status()` reads the grants; this
   *  reads whether the capability's instance exists. */
  isUnlocked(cap: Capability): boolean;
  /**
   * Calls `call` with the talker of the live epoch and answers what it
   * returns, or undefined while chat is locked. Starting and stopping the
   * talker are the registry's. A `CredentialRejected` that
   * `call` throws, or that the promise it returns rejects with, runs the
   * grant's fault flow before it reaches the caller. Read the talker inside
   * `call` only: a talker held past it outlives a relock unguarded.
   */
  withTalker<T>(call: (talker: Omit<Talker, "start" | "stop">) => T): T | undefined;
  /** Hears each message the live talker delivers until chat relocks, or null
   *  while chat is locked. */
  hearTalker(handler: (message: Message) => Promise<void>): (() => void) | null;
  /** A typed handle iff unlocked, else null — presence IS the runtime check. */
  get act(): Act | null;
  get watch(): Watch | null;
}

/** What every push from the remote service looks like. Raw bytes + headers stay intact
 *  so origin verification can HMAC them. */
export type RawDelivery = { body: Uint8Array; headers: Record<string, string>; json: unknown };

/** The runtime services builders need, handed to build(). */
export interface RuntimeKit {
  readonly connectionId: ConnectionId;
  /** Write-through custody (Baileys). Updates the grant's stored credential
   *  material IN PLACE: no epoch rebuild, no state change, no onUnlocked. */
  persist(material: SecretRecord): Promise<void>;
  registerIngress(handler: (input: unknown) => Promise<unknown>): () => void;
  // kit.webhook() lands in phase 6 — do not add it now.
}

/** How long a delivered message may wait to be recorded before its
 *  delivery rejects, so the platform can deliver it again. A chat records its
 *  messages one at a time, so a message waits behind its chat's earlier ones. */
export const DELIVERY_ACCEPT_TIMEOUT_MS = 2 * 60_000;

/** A delivery that a consumer refused to accept for now, though nothing is
 *  wrong with the message or its handler: the platform can deliver it again.
 *  Each kind of refusal is logged where it happens, so it is not a handler
 *  error (Talker.start). */
export class DeliveryRefused extends Error {}

/** A delivery's rejection when nothing records its message: recording
 *  stopped before the message was on record, or nobody records the channel
 *  now, as during a hook swap or while no app's message hook is loaded. A
 *  connection can let its platform deliver the message again without treating
 *  the refusal as a fault, and the message stays with the platform until
 *  recording is back. */
export class RecordingStopped extends DeliveryRefused {
  constructor() {
    super("dropped before it was recorded: recording stopped");
    this.name = "RecordingStopped";
  }
}

/** A delivery's rejection when its message was not recorded within
 *  {@link DELIVERY_ACCEPT_TIMEOUT_MS}, as behind a busy chat. The platform can
 *  deliver it again, and Chats records it once. */
export class NotRecordedInTime extends DeliveryRefused {
  constructor(timeoutMs: number) {
    super(`not recorded within ${timeoutMs}ms`);
    this.name = "NotRecordedInTime";
  }
}

/** Builder-side Talk implementation. Long-lived; faults are REPORTED not thrown. */
export interface Talker extends TalkFeatures {
  /**
   * Starts the transport, which calls `deliver` for each message heard.
   *
   * Order, per chat: `deliver` is called for a chat's messages in the order
   * the platform gave them, even when one needs a lookup first, such as a
   * reply's author. Core keeps the order `deliver` is called in, so a
   * Talker that calls it late for a slow message reorders the chat for good.
   * Different chats may deliver in any order. A `KeyedMutex` keyed by chat,
   * held from the platform's event to `deliver`, keeps the rule; the adapter
   * conformance suite checks it.
   *
   * Acceptance: a Talker that declares {@link Talker.awaitsAcceptance} gets
   * from `deliver` a promise that settles once the message's consumers have
   * accepted it. For Chats that means recorded in its chat, or found on
   * record already. It rejects when a consumer did not accept it: dropped
   * before it was recorded, failed, or not recorded within
   * {@link DELIVERY_ACCEPT_TIMEOUT_MS}. A message Rome decides to leave out,
   * such as one with nothing to answer or from a sender admission refuses,
   * counts as accepted. Any other Talker gets nothing back, so forwarding
   * `deliver` from a receive loop never makes the loop wait on recording.
   * Either way `deliver` returns at once, and awaiting the promise never
   * holds up the next `deliver`: the order is the order of the calls
   * (docs/domains/connections.md#message).
   */
  start(deliver: (msg: Message) => void | Promise<void>, fault: (err: StreamFault) => void): void;
  /** Contract: a Talker that sets this tells its platform it has a message
   *  only after that message's delivery has resolved, and never after one
   *  that rejected, so the platform delivers it again. Only then does
   *  `deliver` return the acceptance promise (`start`). Absent means it does
   *  not wait. */
  readonly awaitsAcceptance?: boolean;
  /** Stop the transport. May return a promise the runtime awaits on graceful
   *  shutdown (`ConnectionRegistry.stopAll`) so in-flight sends / long-poll
   *  drain before the process exits; relock teardown does NOT await it. */
  stop(): void | Promise<void>;
  send(chatId: ChatId, msg: OutgoingMessage): Promise<MessageReceipt>;
}

/** Builder-side Act implementation. */
export interface Actor {
  operations(): readonly OperationDescriptor[];
  invoke(call: OperationCall): Promise<OperationResult>;
  /** Cancel work retained beyond one invocation when this credential epoch is
   * torn down. Stateless actors may omit it. */
  stop?(): void | Promise<void>;
}

/** Builder-side Watch implementation. Long-lived; faults are REPORTED not thrown. */
export interface Watcher {
  start(emit: (event: WatchEvent) => void, fault: (err: StreamFault) => void): void;
  /** Stop the transport. May return a promise the runtime awaits on graceful
   *  shutdown (`ConnectionRegistry.stopAll`); relock teardown does NOT await it. */
  stop(): void | Promise<void>;
}

export type StreamFault = CredentialRejected | Disconnected;

/**
 * Out-of-process custody artifacts materialized from a grant's state (custody
 * is a pure function of grant state). Some grants must share their
 * credential with a consumer that can't read the ledger — an out-of-process tool
 * (the `gh`/git shell wrappers) or a sandboxed app (the `connector` reading a
 * tmpfs token file). The registry drives those artifacts off grant transitions,
 * NOT off any capability build: `sync` runs whenever a grant reaches
 * `authorized` (fresh grant, renew, or boot rehydration) with that grant's
 * live secret `material` plus its integration-owned non-secret `profile`;
 * `clear` runs on revoke AND on
 * degrade. Both are fire-and-forget: a failure is logged and swallowed so it can
 * never fail the transition — the ledger is authoritative, and the next
 * transition or boot re-syncs.
 */
export interface GrantCustody {
  sync(material: SecretRecord, profile: ProfileRecord): Promise<void>;
  clear(): Promise<void>;
}

/** The chat settings a kind's adapter reads and writes for its own chats,
 *  as in-chat commands do, and tells of the chats it sees. */
export type ChatSettingsPort = ChatSettingsControl & {
  observe?(descriptor: ChatDescriptor): void;
};

/** A connection kind declaration. */
export interface ConnectionDescriptor {
  connectionKind: string;
  /** The kind's display name, as a person reads it ("GitHub"). A connection's
   *  own `label` is the kind id until someone renames it, so surfaces that name
   *  a service read this instead. A kind that leaves it unset shows its id. */
  label?: string;
  /** The name of the connection's one grant: the key the dashboard, the setup
   *  routes and the ledger know it by. */
  grant: GrantName;
  /** How the guardian gives access. A connection holds one grant
   *  (docs/domains/connections.md#grant). */
  auth: AuthScheme;
  /** Revive a grant's stored opaque profile record: re-parse it with this
   *  connection kind's own schema, then map it through the connection kind's pure display
   *  function. Fail-closed — a record that no longer matches the schema throws
   *  rather than displaying sparsely. Generic readers consume only the returned
   *  display object; raw records never cross to generic surfaces. */
  reviveProfile?(record: ProfileRecord): ProfileDisplay;
  /** Which field of the revived profile a mention of the account shows:
   *  the handle unless the kind says otherwise, as Feishu does, whose handle
   *  is its application id. */
  mentionedBy?: "handle" | "displayName";
  /** Grant-state-driven custody of out-of-process artifacts (token files, shell
   *  auth). Omitted by connection kinds with no such artifact — most descriptors. */
  custody?: GrantCustody;
  /**
   * Take back at the platform what the grant gave, when the guardian
   * disconnects: revoke a token, release a binding. It runs before the
   * connection is deleted, with the grant's material and profile, and only for
   * a disconnect the guardian asked for, never when a grant degrades or a fix
   * ends a connection. A rejection does not stop the disconnect: the
   * connection still ends, and the reason comes back to the guardian, since
   * the access may still be live at the platform. Run again after a failure,
   * it must finish what is left. Omitted by kinds with nothing to take back.
   * `signal` aborts when the disconnect stops waiting, after which the
   * connection is gone and may be connected again, so the kind must change
   * nothing more at the platform.
   */
  onDisconnect?(
    grant: { material: SecretRecord; profile: ProfileRecord },
    opts: { signal: AbortSignal },
  ): Promise<void>;
  /** True when the guardian can add another account of this connection kind, each
   *  with its own Connection and channel. A connection kind that keeps its stores or
   *  adapter state under one channel, or is a single presence by nature
   *  (webchat, email), leaves it unset. Vocabulary:
   *  docs/domains/chats.md#account. */
  severalAccounts?: boolean;
  /** True when agents act on the platform with this kind's grant alone,
   *  through the connector's proxy, though the kind has no actor: `act` is
   *  then unlocked while every grant is authorized (connections/acts-with-grant.ts).
   *  Absent means they do not. */
  actsWithGrant?: boolean;
  /** The platform's own id for the account a grant's profile names (a bot id,
   *  an app id, an inbox address), or null when the profile names none. It reads
   *  the one field rather than parsing the strict profile schema, so a stored
   *  profile with an extra key still names its account.
   *  The ledger stores it on the grant with the account's platform. Grant
   *  refuses an account another live grant reaches on that platform, whatever
   *  its connection kind, and a fix that reaches another account
   *  (docs/domains/connections.md#connection). A connection kind that leaves it
   *  unset, or a profile it answers null for, is never refused. */
  accountIdOf?(profile: ProfileRecord): string | null;
  /** The kind of link an agent has to this kind's accounts: `own_account` for
   *  an account made for the agent, `delegate` for the guardian's own signed-in
   *  account. A kind that leaves it unset takes no agent. It is the one place
   *  that says which kinds take an agent. Vocabulary:
   *  docs/domains/chats.md#connected-account. */
  link?: AccountLink;
  /** True when a newly connected own account of this kind starts with the
   *  Concierge as its agent, so it answers from its first message. Absent, it
   *  starts with none until the guardian links one. */
  startsWithConcierge?: boolean;
  /** The chat rules the kind's chats offer the guardian, and the values it
   *  fixes for the rules it does not offer. Core owns the rules and runs
   *  them. A kind that hears messages declares it: one that leaves it unset
   *  runs as Core's undeclared rules, the session reset alone with every
   *  message waking the agent. A kind that offers nothing, as an official app,
   *  declares `{ offers: [] }`, so every rule runs at its default.
   *  Vocabulary: docs/domains/chats.md#chat-rule. */
  chatRules?: KindChatRules;
  capabilities: Partial<{
    talker: {
      build(cred: Credential, kit: RuntimeKit): Talker;
      degradation?(instance: Talker): CapabilityDegradation | null;
      /** False when the talker can never send, so the channel it backs has no
       *  `send` port. Absent means it can. */
      sends?: boolean;
      /** False when this Talk's deliveries do not back the channel's `inbound`
       *  port, so that channel has none. It says what the Talk backs, not what
       *  the talker does: webchat's talker is wired to `deliver`, but its turns
       *  start from its own route. Absent means the deliveries back it. */
      receives?: boolean;
      /** True when the talker reads a chat's history from the platform
       *  (`TalkHistory`), so the channel it backs has a `messages` port read
       *  live. Absent means it does not, and the channel reads no messages. */
      reads?: boolean;
      /** True when the surface that delivers this channel's next human turn
       *  renders interactive cards, so an agent may pause on one for a reply.
       *  Absent means it does not, and a card falls back to prose. */
      interactiveCards?: boolean;
      /** False when every message in a conversation already reaches the agent
       *  as a turn, so a prompt needs no preamble of stored messages the agent
       *  has not seen. Absent means the channel stores messages the agent
       *  never saw, such as other people's lines in a group. */
      promptContext?: boolean;
    };
    actor: {
      /** Static discovery contract for App SDK operations. Required when any
       * operation opts into `appAccess`. */
      operations?: readonly OperationDescriptor[];
      build(cred: Credential, kit: RuntimeKit): Actor;
    };
    watcher: {
      subscriptionGated?: boolean;
      build(cred: Credential, kit: RuntimeKit): Watcher;
    };
  }>;
}
