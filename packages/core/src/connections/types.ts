// Connection caller and builder contracts. Messaging model: docs/concepts/messaging.md.
//
// The runtime never inspects the contents of a credential's `material` (only
// the `expiresAt` envelope).

import type {
  ChannelMessage,
  ConversationDescriptor,
  ConversationId,
  MessageReceipt,
  OutgoingMessage,
  ChannelActivity,
  ChannelDirectMessaging,
  ChannelInboundMedia,
} from "@rome-os/app-runtime";
import type { CredentialRejected, Disconnected } from "./errors.js";

// ── Talk ─────────────────────────────────────────────────────────────────────
// A Connection's conversational surface, as its builder implements it
// (`Talker`). Only the channel ports (channels/connection-ports.ts) reach it,
// through `Connection.withTalker`: apps reach channels through the channels
// service (actions) or a hook's `channels`. A talker delivers each message as
// the channel's own record: a `ChannelMessage` naming the channel it backs,
// with direction `inbound`.

/**
 * The platform's own history of a Connection's conversations: at most `limit`
 * of them at or after `since`, oldest first, each saying which channel carried
 * it and which way it went. It backs `messages.query` for a channel with no
 * store of its own (channels/connection-ports.ts).
 */
export interface TalkHistory {
  query(input: {
    conversationId?: ConversationId;
    since?: Date;
    limit?: number;
  }): Promise<ChannelMessage[]>;
}

/** The conversations a Connection can see, for conversation settings. */
export interface TalkDirectory {
  listConversations(input: {
    query?: string;
    cursor?: string;
    limit: number;
    includeTopics?: boolean;
  }): Promise<{ conversations: ConversationDescriptor[]; nextCursor?: string }>;
}

export interface TalkFeatureMap {
  history: TalkHistory;
  inboundMedia: ChannelInboundMedia;
  activity: ChannelActivity;
  directory: TalkDirectory;
  directMessaging: ChannelDirectMessaging;
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
export type Capability = "talk" | "act" | "watch";
export type SecretRecord = Record<string, string>;
/**
 * The non-secret half of a grant's conferral outcome. Like SecretRecord, this
 * is deliberately opaque to the connection framework: each integration owns
 * the keys and value shapes it stores here.
 */
export type ProfileRecord = Record<string, unknown>;

// OutgoingMessage is the existing @rome-os/app-runtime shape (phase 2 collapses
// the message contract; do not invent a new shape now).
export type { ConversationId, MessageReceipt, OutgoingMessage } from "@rome-os/app-runtime";

export interface OperationCall {
  operation: string;
  input?: unknown;
}
export type OperationResult = unknown;

export interface OperationDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
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
 * Conferral ceremonies are not implemented for `confer`; this is the minimal
 * placeholder so `AuthScheme` compiles. Headless conferrals (tests, settings
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
 * with the service's own schema and maps the parsed plain data through the
 * service's pure display function — the returned display object is what
 * satisfies this readonly interface. Service-specific values that generic
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
  confer(interact: GuardianInteraction): Promise<Credential>;
  /**
   * the guardian-facing conferral setup for this grant. When present,
   * the generic setup surface (`POST
   * /api/connections/:id/grants/:name/setup`) drives it: a server-owned
   * coroutine that prompts/shows/redirects and returns a terminal conferral
   * (credential + profile + optional guardian mapping). Absent for grants with
   * no dashboard setup (headless imports, OAuth redirect routes). Kept
   * `unknown`-free by importing the setup type lazily to avoid a cycle: see
   * `./setup/types.ts`.
   */
  setup?: import("./setup/types.js").SetupFn;
  /** Renew WITHOUT the guardian, if the scheme can; "re-confer" is the honest
   *  answer for pasted tokens and pairing sessions. Required, not optional. */
  renew(cred: Credential): Promise<Credential | "re-confer">;
  /**
   * External-custody resolver. When a rehydrated credential persisted
   * as `{ kind: "external" }`, the registry re-wraps its live `material` with
   * this resolver — rehydration must never confer.
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

/** One service, named grants, up to three capabilities. */
export interface Connection {
  readonly id: ConnectionId;
  readonly service: string;
  readonly label: string;
  readonly auth: AuthState;
  /** Discovery with reasons — drives the dashboard and connect hints. */
  status(): Record<Capability, CapabilityStatus>;
  /** Whether `cap` is built and live now. `status()` reads the grants; this
   *  reads whether the capability's instance exists. */
  isUnlocked(cap: Capability): boolean;
  /**
   * Calls `call` with the talker of the live epoch and answers what it
   * returns, or undefined while talk is locked. Starting and stopping the
   * talker are the registry's. A `CredentialRejected` that
   * `call` throws, or that the promise it returns rejects with, runs the
   * grant's fault flow before it reaches the caller. Read the talker inside
   * `call` only: a talker held past it outlives a relock unguarded.
   */
  withTalker<T>(call: (talker: Omit<Talker, "start" | "stop">) => T): T | undefined;
  /** Hears each message the live talker delivers until talk relocks, or null
   *  while talk is locked. */
  hearTalker(handler: (message: ChannelMessage) => Promise<void>): (() => void) | null;
  /** A typed handle iff unlocked, else null — presence IS the runtime check. */
  get act(): Act | null;
  get watch(): Watch | null;
}

/** What every push from the service looks like. Raw bytes + headers stay intact
 *  so origin verification can HMAC them. */
export type RawDelivery = { body: Uint8Array; headers: Record<string, string>; json: unknown };

/** The runtime services builders need, handed to build(). */
export interface RuntimeKit {
  readonly connectionId: ConnectionId;
  /** Write-through custody (Baileys). Updates the grant's stored credential
   *  material IN PLACE: no epoch rebuild, no state change, no onUnlocked. */
  persist(grant: GrantName, material: SecretRecord): Promise<void>;
  registerIngress(handler: (input: unknown) => Promise<unknown>): () => void;
  // kit.webhook() lands in phase 6 — do not add it now.
}

/** Builder-side Talk implementation. Long-lived; faults are REPORTED not thrown. */
export interface Talker extends TalkFeatures {
  start(deliver: (msg: ChannelMessage) => void, fault: (err: StreamFault) => void): void;
  /** Stop the transport. May return a promise the runtime awaits on graceful
   *  shutdown (`ConnectionRegistry.stopAll`) so in-flight sends / long-poll
   *  drain before the process exits; relock teardown does NOT await it. */
  stop(): void | Promise<void>;
  send(conversationId: ConversationId, msg: OutgoingMessage): Promise<MessageReceipt>;
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
 * `authorized` (fresh conferral, renew, or boot rehydration) with that grant's
 * live secret `material` plus its integration-owned non-secret `profile`;
 * `clear` runs on revoke AND on
 * degrade. Both are fire-and-forget: a failure is logged and swallowed so it can
 * never fail the transition — the ledger is authoritative, and the next
 * transition or boot re-syncs.
 */
export interface GrantCustody {
  sync(grant: GrantName, material: SecretRecord, profile: ProfileRecord): Promise<void>;
  clear(grant: GrantName): Promise<void>;
}

/** A service integration declaration. */
export interface ConnectionDescriptor {
  service: string;
  auth: Record<GrantName, AuthScheme>;
  /** Revive a grant's stored opaque profile record: re-parse it with this
   *  service's own schema, then map it through the service's pure display
   *  function. Fail-closed — a record that no longer matches the schema throws
   *  rather than displaying sparsely. Generic readers consume only the returned
   *  display object; raw records never cross to generic surfaces. */
  reviveProfile?(grant: GrantName, record: ProfileRecord): ProfileDisplay;
  /** Grant-state-driven custody of out-of-process artifacts (token files, shell
   *  auth). Omitted by services with no such artifact — most descriptors. */
  custody?: GrantCustody;
  capabilities: Partial<{
    talker: {
      needs: readonly GrantName[];
      build(creds: Record<GrantName, Credential>, kit: RuntimeKit): Talker;
      degradation?(instance: Talker): CapabilityDegradation | null;
      /** False when the talker can never send, so the channel it backs has no
       *  `send` port. Absent means it can. */
      sends?: boolean;
      /** False when this Talk's deliveries do not back the channel's `inbound`
       *  port, so that channel has none. It says what the Talk backs, not what
       *  the talker does: webchat's talker is wired to `deliver`, but its turns
       *  start from its own route. Absent means the deliveries back it. */
      receives?: boolean;
      /** True when the Talk reads the platform's own history, so the channel it
       *  backs answers `messages.query` through it. Absent means it does not:
       *  the channel's messages come from a store, or from nowhere. */
      history?: boolean;
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
      needs: readonly GrantName[];
      build(creds: Record<GrantName, Credential>, kit: RuntimeKit): Actor;
    };
    watcher: {
      needs: readonly GrantName[];
      subscriptionGated?: boolean;
      build(creds: Record<GrantName, Credential>, kit: RuntimeKit): Watcher;
    };
  }>;
}
