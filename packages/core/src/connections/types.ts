// Connection caller and builder contracts. Messaging model: docs/concepts/messaging.md.
//
// The runtime never inspects the contents of a credential's `material` (only
// the `expiresAt` envelope).

import type {
  ConversationId,
  InboundMessage,
  MessageReceipt,
  OutgoingMessage,
  Talk,
  TalkFeatureMap,
  TalkFeatureName,
} from "@rome-os/app-runtime";
import type { CredentialRejected, Disconnected } from "./errors.js";

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
export type {
  ConversationId,
  InboundMessage,
  MessageReceipt,
  OutgoingMessage,
  Talk,
  TalkFeatureMap,
  TalkFeatureName,
} from "@rome-os/app-runtime";

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
  /** A typed handle iff unlocked, else null — presence IS the runtime check. */
  get talk(): Talk | null;
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
export interface Talker {
  start(deliver: (msg: InboundMessage) => void, fault: (err: StreamFault) => void): void;
  /** Stop the transport. May return a promise the runtime awaits on graceful
   *  shutdown (`ConnectionRegistry.stopAll`) so in-flight sends / long-poll
   *  drain before the process exits; relock teardown does NOT await it. */
  stop(): void | Promise<void>;
  send(conversationId: ConversationId, msg: OutgoingMessage): Promise<MessageReceipt>;
  feature<K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null;
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
