// Connection lifecycle registry. Vocabulary: docs/domains/connections.md.

import type { ChannelMessage } from "@rome-os/app-runtime";
import type { DrizzleTx } from "../db/index.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { createLogger, type Logger } from "../logger.js";
import { isUnconnectedAccount } from "./unconnected-accounts.js";
import {
  type GrantAccount,
  type GrantRecord,
  type GrantValue,
  NO_GRANT,
  type PersistedCredential,
} from "./grant.js";
import {
  accountOf,
  brokenGrant,
  givenGrant,
  reachedAccount,
  refuseDifferentAccount,
  renewedGrant,
  sameAccount,
  toPersisted,
} from "./connection.js";
import type { ConnectionEventHandler } from "./events.js";
import type { ConnectionRecord, ConnectionsRepository } from "./repository.js";
import {
  AccountAlreadyConnectedError,
  CredentialRejected,
  Disconnected,
  DuplicateKindConnectionsError,
  RenewalUnavailable,
} from "./errors.js";
import type {
  Act,
  Actor,
  AuthScheme,
  AuthState,
  Capability,
  CapabilityStatus,
  Connection,
  ConnectionState,
  ConnectionDescriptor,
  ConnectionId,
  Credential,
  GrantName,
  GrantState,
  OperationCall,
  OperationResult,
  ProfileRecord,
  RuntimeKit,
  SecretRecord,
  StreamFault,
  Talker,
  Watch,
  WatchEvent,
  Watcher,
} from "./types.js";

type CapabilityKind = "talker" | "actor" | "watcher";

const KIND_OF: Record<Capability, CapabilityKind> = {
  talk: "talker",
  act: "actor",
  watch: "watcher",
};

/** How {@link ConnectionRegistry.giveGrant} writes. */
export interface GiveGrantOptions {
  /** A participant run in the grant's transaction (the guardian mapping). */
  inTx?: (tx: DrizzleTx) => void;
  /** Mint another account of the connection kind rather than fill its first one. Only
   *  read when no connection id is addressed. */
  another?: boolean;
}

export interface ConnectionRegistryDeps {
  repository: ConnectionsRepository;
  logger?: Logger;
  /** Injectable clock; defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Backoff bounds for Disconnected rebuilds. */
  backoff?: { baseMs: number; maxMs: number };
  /** Injectable sleep for Disconnected backoff waits; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Hears every connection event, inside the transaction that raised it. */
  onEvent?: ConnectionEventHandler;
}

const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rehydrate a live Credential from a persisted envelope. Inline custody hands
 *  back the stored record; external custody re-wraps `resolveExternal` — never
 *  grants. A `{ kind: "external" }` row without a resolver is a descriptor bug. */
function fromPersisted(persisted: PersistedCredential, scheme: AuthScheme): Credential {
  if (persisted.material.kind === "external") {
    const resolve = scheme.resolveExternal;
    if (!resolve) {
      throw new Error("external-custody credential has no resolveExternal on its scheme");
    }
    return { material: resolve, expiresAt: persisted.expiresAt };
  }
  return { material: persisted.material.record, expiresAt: persisted.expiresAt };
}

/** A capability's live epoch: the built instance plus the runtime-facing
 *  wrapper. The wrapper delegates to a MUTABLE current-instance slot so a
 *  Disconnected backoff rebuild can swap the instance while callers keep the
 *  same handle; a relock (grant change) discards the whole epoch. */
interface Epoch {
  /** Monotonic token; every relock/rebuild-from-scratch increments it. */
  readonly token: number;
  /** The current built instance (swapped by backoff rebuild). */
  instance: Talker | Actor | Watcher;
  /** True once the epoch has been torn down; wrapper calls then throw. */
  dead: boolean;
  /** In-flight Disconnected backoff generation; cancels superseded loops. */
  backoffGen: number;
  /** Consecutive Disconnected failures in the current backoff run; the
   *  exponent for the wait, reset to 0 after a stable rebuild. */
  disconnectStreak: number;
}

/** Per-capability slot on a ConnectionImpl. Holds the current epoch (or null
 *  when locked) and the caller-facing wrapper bound to the mutable slot. */
interface CapabilitySlot {
  readonly cap: Capability;
  readonly kind: CapabilityKind;
  readonly needs: readonly GrantName[];
  readonly subscriptionGated: boolean;
  readonly degradation?: (instance: Talker) => import("./types.js").CapabilityDegradation | null;
  epoch: Epoch | null;
  /** Talk/Act/Watch handler registrations for the CURRENT epoch — dropped on
   *  relock so no duplicate listeners survive across epochs. */
  messageHandlers: Array<(msg: ChannelMessage) => Promise<void>>;
  eventHandlers: Array<(event: WatchEvent) => void>;
}

/** A registered descriptor plus its precomputed capability metadata. */
interface RegisteredDescriptor {
  readonly descriptor: ConnectionDescriptor;
}

export class ConnectionRegistry {
  private readonly store: ConnectionsRepository;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly sleep: (ms: number) => Promise<void>;
  /** Raise a connection event to the subscriber. Called by the Connection,
   *  inside the transaction that saved it. */
  readonly raise: ConnectionEventHandler;

  private readonly descriptors = new Map<string, RegisteredDescriptor>();
  private readonly connections = new Map<ConnectionId, ConnectionImpl>();
  private readonly unlockHandlers: Record<Capability, Array<(conn: Connection) => void>> = {
    talk: [],
    act: [],
    watch: [],
  };
  /** Per-(connection kind, grant) critical-section chains for composite ROUTE ceremonies
   *  — a mutex keyed by `${connectionKind}\u0000${grant}`.
   *  See {@link withGrantSection}. This is the registry-owned home of the
   *  serialization the two hand-rolled route mutexes (email, telegram-user) used
   *  to own; keys are bounded by the registered connection kinds × their grants and
   *  evicted when idle. */
  private readonly sectionMutex = new KeyedMutex();
  /** Serializes every connection mint path, so `connect`'s refusal of
   *  a second Connection never races another mint. It holds within one
   *  process, and one Rome process owns a system database. */
  private readonly connectionMutex = new KeyedMutex();
  private readonly ingressHandlers = new Map<ConnectionId, (input: unknown) => Promise<unknown>>();
  private capabilityActivationPaused = false;

  constructor(deps: ConnectionRegistryDeps) {
    this.store = deps.repository;
    this.log = deps.logger ?? createLogger("connections");
    this.clock = deps.clock ?? (() => new Date());
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.sleep = deps.sleep ?? defaultSleep;
    this.raise = deps.onEvent ?? (() => {});
  }

  /** Declare a connection kind. Boot-time only. Validates that the connection
   *  kind is unique. */
  register(desc: ConnectionDescriptor): void {
    if (this.descriptors.has(desc.connectionKind)) {
      throw new Error(
        `duplicate connection descriptor for connection kind "${desc.connectionKind}"`,
      );
    }
    this.descriptors.set(desc.connectionKind, { descriptor: desc });
  }

  /** True iff a descriptor has been registered for `connectionKind`. Lets callers
   *  skip connection kinds this registry does not know about — e.g. a test that
   *  registers only a subset. */
  isRegistered(connectionKind: string): boolean {
    return this.descriptors.has(connectionKind);
  }

  /** Read the registered integration declaration. Generic identity surfaces use
   *  its reviveProfile hook instead of inspecting integration-owned profile keys. */
  getDescriptor(connectionKind: string): ConnectionDescriptor | null {
    return this.descriptors.get(connectionKind)?.descriptor ?? null;
  }

  /** Every registered connection kind — the offerable catalog. Lets the connections
   *  API list connection kinds a guardian could connect that have no connection row yet. */
  registeredKinds(): string[] {
    return Array.from(this.descriptors.keys());
  }

  /** Reconstruct every persisted connection at boot. Reads the repository, rebuilds
   *  Connection objects for known connection kinds (unknown connection kinds are logged and
   *  skipped), builds capabilities for grants that are live, and fires
   *  onUnlocked for each. Expired credentials are renewed once or degraded. */
  async load(options: { deferCapabilities?: boolean } = {}): Promise<void> {
    this.capabilityActivationPaused = options.deferCapabilities ?? false;
    const stored = await this.store.all();
    for (const rec of stored) {
      const registered = this.descriptors.get(rec.connectionKind);
      if (!registered) {
        this.log.warn("Skipping connection for unregistered connectionKind", {
          connectionId: rec.id,
          connectionKind: rec.connectionKind,
        });
        continue;
      }
      const conn = new ConnectionImpl(rec, registered.descriptor, this);
      this.connections.set(rec.id, conn);
      await conn.hydrate(rec.grant);
    }
  }

  /** Start every capability hydrated while boot activation was deferred. Boot
   * uses this barrier so no provider transport starts before its boot passes
   * finish. */
  startCapabilities(): void {
    this.capabilityActivationPaused = false;
    for (const connection of this.connections.values()) {
      connection.activateAvailableCapabilities();
    }
  }

  capabilitiesMayActivate(): boolean {
    return !this.capabilityActivationPaused;
  }

  /** Mint a new Connection from a registered descriptor. Persists the record
   *  and makes sure its grant row exists ("unauthorized"). Refuses a connection kind
   *  that already holds a Connection; a grant asked for another account
   *  (`grant` with `another`) adds a second. */
  async connect(connectionKind: string, label?: string): Promise<Connection> {
    return this.connectionMutex.runExclusive(connectionKind, async () => {
      const existing = this.find(connectionKind);
      if (existing.length > 0) {
        throw new DuplicateKindConnectionsError([
          { connectionKind, connectionIds: existing.map((connection) => connection.id) },
        ]);
      }
      return this.mint(connectionKind, label);
    });
  }

  /** Mint another Connection for a connection kind, whether or not it already holds
   *  one, with no grant held yet. Tests use it to stand up several accounts
   *  without driving a setup.
   *  @internal */
  async connectAnother(connectionKind: string, label?: string): Promise<Connection> {
    return this.connectionMutex.runExclusive(connectionKind, () =>
      this.mint(connectionKind, label),
    );
  }

  private async mint(connectionKind: string, label: string | undefined): Promise<Connection> {
    const registered = this.descriptors.get(connectionKind);
    if (!registered)
      throw new Error(`no registered descriptor for connection kind "${connectionKind}"`);
    const id = crypto.randomUUID();
    const createdAt = this.clock();
    const record = { id, connectionKind, label: label ?? connectionKind, createdAt };
    this.createConnectionWithGrant(record);
    const conn = new ConnectionImpl(record, registered.descriptor, this);
    this.connections.set(id, conn);
    await conn.hydrate(NO_GRANT);
    return conn;
  }

  /** Save a connection that holds no grant yet, in the same transaction seam
   *  as giveGrant(). */
  private createConnectionWithGrant(record: ConnectionRecord): void {
    this.store.transaction((tx) => {
      this.store.save(tx, { ...record, grant: NO_GRANT });
      this.raise(tx, { kind: "connected", connection: record });
    });
  }

  get(id: ConnectionId): Connection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection "${id}"`);
    return conn;
  }

  all(): Connection[] {
    return Array.from(this.connections.values());
  }

  /** Convenience: every loaded connection of a connection kind. */
  find(connectionKind: string): Connection[] {
    return this.all().filter((c) => c.connectionKind === connectionKind);
  }

  /** Stop every live capability instance across every connection WITHOUT
   *  deleting connections or touching grant state — the graceful-shutdown
   *  counterpart to the adapter `stop()` loop. Epochs are torn down (each
   *  Talker/Watcher `stop()` is called and AWAITED); the store is untouched, so
   *  the next boot's `load()` rehydrates and rebuilds them.
   *
   *  Unlike relock teardown, this AWAITS each instance's `stop()` so a transport
   *  that drains asynchronously (grammy's `bot.stop()` letting in-flight sends /
   *  the long-poll finish) completes before the process moves on to telemetry
   *  flush and exit. */
  async stopAll(): Promise<void> {
    for (const conn of this.connections.values()) await conn.teardownAllAwaiting();
  }

  /** Stop every capability instance and delete the connection plus its grants.
   *
   *  `opts.inTx` is an optional caller participant (the `grant` seam,
   *  mirrored for teardown) enlisted in the SAME transaction as the connection/
   *  grant deletes, so a caller's cleanup can never be left stranded by a
   *  failure after the connection is already committed as deleted. The in-memory teardown (`teardownAll`) and map eviction run only
   *  AFTER that transaction commits. */
  async remove(id: ConnectionId, opts: { inTx?: (tx: DrizzleTx) => void } = {}): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection "${id}"`);
    await this.connectionMutex.runExclusive(conn.connectionKind, async () => {
      const current = this.connections.get(id);
      if (!current) throw new Error(`unknown connection "${id}"`);
      this.store.transaction((tx) => {
        this.store.remove(tx, id);
        this.raise(tx, {
          kind: "disconnected",
          connection: { id, connectionKind: current.connectionKind },
        });
        opts.inTx?.(tx);
      });
      current.teardownAll();
      this.connections.delete(id);
    });
  }

  /** End a connection, whatever its kind: remove it and its grant in one
   *  transaction that raises disconnected, then stop its capabilities and
   *  clear the grant's custody artifacts. Runs in the grant's section, so it
   *  never interleaves with a setup's terminal write. A failed write throws
   *  and leaves the connection as it was. */
  async disconnect(id: ConnectionId): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection "${id}"`);
    const { connectionKind } = conn;
    const grant = conn.descriptor.grant;
    await this.withGrantSection(connectionKind, grant, () =>
      this.connectionMutex.runExclusive(connectionKind, async () => {
        // A disconnect that ran while this one waited may have removed it.
        if (this.connections.get(id) !== conn) return;
        await conn.disconnect(grant);
        this.connections.delete(id);
      }),
    );
  }

  /** Commit grant revocation and the caller's cleanup together before stopping capabilities. */
  revoke(
    id: ConnectionId,
    grant: GrantName,
    opts: { inTx?: (tx: DrizzleTx) => void } = {},
  ): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection "${id}"`);
    return conn.revoke(grant, opts);
  }

  /** The terminal grant write: authorize `grant` with a proven
   *  credential + profile, minting the addressed placeholder connection when it
   *  has no row yet, and running the caller's participant (`opts.inTx` — the
   *  guardian channel mapping) — ALL inside ONE transaction. A participant
   *  failure rolls back the credential AND the mint together, so a failed
   *  grant leaves zero residual state (the partial-write fix).
   *
   *  The adapter is started AFTER the commit, deliberately outside the
   *  transaction (a live socket cannot be rolled back): a start failure is
   *  logged, not fatal — the grant is durably authorized and its mapping
   *  consistent, so reconcile/boot brings the adapter up. That degraded state is
   *  never the "success and failure at once" a partial write produced.
   *
   *  `connectionId` addresses an existing connection (fails if it vanished
   *  mid-setup rather than resurrecting into `find()[0]`); omit it for an
   *  offerable placeholder (reuse the first existing connection of the connection kind,
   *  else mint one), or omit it with `opts.another` to mint another account of
   *  the connection kind whether or not it holds one. This owns the resolve/mint the
   *  manager's terminal write did inline before. */
  async giveGrant(
    connectionKind: string,
    connectionId: ConnectionId | undefined,
    grant: GrantName,
    credential: Credential,
    profile?: ProfileRecord,
    opts: GiveGrantOptions = {},
  ): Promise<Connection> {
    return this.connectionMutex.runExclusive(connectionKind, () =>
      this.giveGrantExclusive(connectionKind, connectionId, grant, credential, profile, opts),
    );
  }

  /** The Connection a placeholder grant fills: the connection kind's own, unless
   *  that is an account a failed removal left behind, which a connecting
   *  account must not inherit, so a fresh one is minted beside it. */
  private async placeholderTarget(connectionKind: string): Promise<ConnectionImpl | undefined> {
    const conn = this.find(connectionKind)[0] as ConnectionImpl | undefined;
    return conn && !(await isUnconnectedAccount(this, conn)) ? conn : undefined;
  }

  private async giveGrantExclusive(
    connectionKind: string,
    connectionId: ConnectionId | undefined,
    grant: GrantName,
    credential: Credential,
    profile: ProfileRecord | undefined,
    opts: GiveGrantOptions,
  ): Promise<Connection> {
    const registered = this.descriptors.get(connectionKind);
    let conn: ConnectionImpl | undefined = connectionId
      ? this.connections.get(connectionId)
      : opts.another
        ? undefined
        : await this.placeholderTarget(connectionKind);
    if (connectionId && !conn) {
      throw new Error(`Connection "${connectionId}" no longer exists; setup cannot grant.`);
    }
    const minting = !conn;
    if (minting && !registered) {
      throw new Error(`no registered descriptor for connection kind "${connectionKind}"`);
    }

    const id = conn?.id ?? crypto.randomUUID();
    const account =
      registered && profile !== undefined ? accountOf(registered.descriptor, profile) : undefined;
    if (registered && account) {
      if (conn) {
        const held = (await this.store.grantOf(id)) ?? NO_GRANT;
        refuseDifferentAccount(registered.descriptor, id, held, account);
      }
      await this.refuseAccountHeldElsewhere(registered.descriptor, id, account);
    }
    const createdAt = this.clock();
    const grantValue = givenGrant(this.now(), credential, crypto.randomUUID(), profile, account);
    const record: ConnectionRecord = conn?.record ?? {
      id,
      connectionKind,
      label: connectionKind,
      createdAt,
    };

    // One transaction spanning every durable write of the grant: mint (if a
    // placeholder), the credential/profile, and the caller's participant.
    const commit = () =>
      this.store.transaction((tx) => {
        this.store.save(tx, { ...record, grant: grantValue });
        this.raise(
          tx,
          minting
            ? { kind: "connected", connection: record, profile, account }
            : { kind: "fixed", connection: { id, connectionKind }, account },
        );
        opts.inTx?.(tx);
      });
    const logActivationFailure = (err: unknown) => {
      this.log.error("grant committed but adapter activation failed", {
        connectionKind,
        connectionId: id,
        grant,
        error: err instanceof Error ? err.message : String(err),
      });
    };

    // Committed — store + mapping are consistent. Bring the adapter live;
    // best-effort per the doc comment. A minted connection hydrates exactly as
    // it would at boot (rebuilds the epoch from the just-persisted grant); an
    // existing one commits and activates just this grant under the grant's
    // lock, so a renewal in flight on the same grant finishes before this
    // grant writes and can never land over it.
    if (minting) {
      commit();
      try {
        conn = new ConnectionImpl(record, registered!.descriptor, this);
        this.connections.set(id, conn);
        await conn.hydrate(grantValue);
      } catch (err) {
        logActivationFailure(err);
      }
    } else {
      await conn!.commitAndActivateGrant(grant, credential, commit, logActivationFailure);
    }
    return conn as Connection;
  }

  /** Throws AccountAlreadyConnectedError when another Connection, of any kind,
   *  holds a grant in any state but "unauthorized" that reaches `account`. Under
   *  the connection kind's `connectionMutex` no grant of this kind can fill
   *  another Connection between this read and the caller's write. A grant of
   *  another kind on the same platform can, and the store's unique index on
   *  the account refuses the later write. */
  private async refuseAccountHeldElsewhere(
    descriptor: ConnectionDescriptor,
    connectionId: ConnectionId,
    account: GrantAccount,
  ): Promise<void> {
    const other =
      (await this.store.reaching(account, connectionId)) ??
      (await this.unrecordedReaching(account, connectionId));
    if (other) {
      throw new AccountAlreadyConnectedError(descriptor.connectionKind, account.accountId, other);
    }
  }

  /** The Connection, other than `exceptId`, whose held grant has no stored
   *  account but whose profile names `account`. The boot pass leaves such a
   *  grant when an older connection reached the same account, and it still
   *  reaches that account once the older one is disconnected. */
  private async unrecordedReaching(
    account: GrantAccount,
    exceptId: ConnectionId,
  ): Promise<ConnectionId | null> {
    for (const record of await this.store.heldWithoutAccount(exceptId)) {
      const kind = this.connections.get(record.custody)?.connectionKind;
      const descriptor = kind ? this.descriptors.get(kind)?.descriptor : undefined;
      const held = descriptor ? reachedAccount(descriptor, record) : undefined;
      if (held && sameAccount(held, account)) {
        return record.custody;
      }
    }
    return null;
  }

  /** In-memory subscription gate for subscription-gated Watchers (phase 6
   *  persists real subscription state). Transitions build/teardown the watch
   *  epoch and fire onUnlocked exactly like a grant change. */
  async setWatchSubscribed(connectionId: ConnectionId, subscribed: boolean): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`unknown connection "${connectionId}"`);
    await conn.setWatchSubscribed(subscribed);
  }

  /** Renew every authorized credential that expires within `withinMs`, before it
   *  lapses. A credential nothing reports as rejected (an OAuth token a separate
   *  process reads from its custody file) never reaches the fault-driven renew, so
   *  without this it would expire in place. Connections renew independently: one
   *  failure never stops the others. */
  async renewExpiring(withinMs: number): Promise<void> {
    await Promise.all(
      [...this.connections.values()].map((conn) =>
        conn.renewExpiring(withinMs).catch((err) => {
          this.log.error("expiring-credential renewal failed", {
            connectionId: conn.id,
            error: errMsg(err),
          });
        }),
      ),
    );
  }

  /** Run a composite lifecycle ceremony inside the registry-owned critical
   *  section for `(connection kind, grant)`: it starts only once every previously
   *  enqueued section on the SAME (connection kind, grant) has settled, so overlapping
   *  route ceremonies queue (FIFO) instead of interleaving. This is the scoped
   *  primitive channel routes wrap a multi-step sequence in — consume a pending
   *  login attempt then grant; cancel then revoke; write a settings row, giveGrant,
   *  and compensate on failure.
   *
   *  It is keyed by (connection kind, grant), not by connection id, on purpose: a connect
   *  ceremony mints its connection *inside* the section (`find(connectionKind)[0] ??
   *  connect()`), so there is no id to key on until the section has already run,
   *  and two overlapping connects must serialize through the SAME chain to
   *  converge on exactly one connection. Different grants of one connection kind — and
   *  different connection kinds — hold independent chains and never serialize against
   *  each other.
   *
   *  Composition is deadlock-free by construction: a registry grant mutation
   *  invoked from inside the section (`grant`, `revoke`) acquires only the per-connection grant lock — a
   *  DISTINCT lock this section never holds and which is uncontended while the
   *  section runs — so it runs without re-queueing behind other section work and
   *  cannot deadlock against the section (reentrancy by scope falls out of the
   *  two-layer keying).
   *
   *  A ceremony that rejects neither poisons the next ceremony on the section
   *  nor surfaces as an unhandled rejection (the keyed mutex releases either
   *  way); the original result/rejection is returned to THIS caller unchanged.
   *  Mirrors {@link ConnectionImpl.withGrantLock}. */
  withGrantSection<T>(connectionKind: string, grant: GrantName, fn: () => Promise<T>): Promise<T> {
    const key = `${connectionKind}\u0000${grant}`;
    return this.sectionMutex.runExclusive(key, fn);
  }

  /** Register an unlock handler. Fires immediately for every already-unlocked
   *  connection, then for every future unlock epoch (connect, load,
   *  grant, fix after degrade, subscription arrival).
   *
   *  Delivery guarantee: only handlers a caller registers SYNCHRONOUSLY inside
   *  the onUnlocked callback (via `conn.hearTalker` / `conn.watch.onEvent`)
   *  are guaranteed to see the epoch's FIRST deliveries. For a fresh unlock epoch
   *  the registry fires onUnlocked before the capability's stream starts, so a
   *  synchronous registration is wired before start() runs; a handler attached
   *  later (after an await, or on an already-unlocked connection whose stream is
   *  already running) may miss deliveries the stream emitted synchronously from
   *  start(). Send-before-start is permitted: the instance exists when the
   *  callback runs, so a send through `conn.withTalker` inside it works. */
  onUnlocked(cap: Capability, handler: (conn: Connection) => void): void {
    this.unlockHandlers[cap].push(handler);
    for (const conn of this.connections.values()) {
      if (conn.isUnlocked(cap)) this.fireOne(cap, handler, conn);
    }
  }

  registerIngress(
    connectionId: ConnectionId,
    handler: (input: unknown) => Promise<unknown>,
  ): () => void {
    this.ingressHandlers.set(connectionId, handler);
    return () => {
      if (this.ingressHandlers.get(connectionId) === handler)
        this.ingressHandlers.delete(connectionId);
    };
  }

  async ingest(connectionId: ConnectionId, input: unknown): Promise<unknown> {
    const handler = this.ingressHandlers.get(connectionId);
    if (!handler) throw new Error(`Ingress is unavailable for connection "${connectionId}"`);
    return handler(input);
  }

  /** Fire every registered handler for a capability's fresh unlock epoch. */
  fireUnlock(cap: Capability, conn: Connection): void {
    for (const handler of this.unlockHandlers[cap]) this.fireOne(cap, handler, conn);
  }

  private fireOne(cap: Capability, handler: (conn: Connection) => void, conn: Connection): void {
    try {
      handler(conn);
    } catch (err) {
      this.log.error("onUnlocked handler threw", {
        capability: cap,
        connectionId: conn.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** The grant connection `id` holds, or null when Rome holds no
   *  connection `id`. */
  grantOf(id: ConnectionId): Promise<GrantValue | null> {
    return this.store.grantOf(id);
  }

  /** The store a Connection saves itself to.
   *  @internal */
  getRepository(): ConnectionsRepository {
    return this.store;
  }
  getLogger(): Logger {
    return this.log;
  }
  now(): Date {
    return this.clock();
  }
  getBackoff(): { baseMs: number; maxMs: number } {
    return this.backoff;
  }
  doSleep(ms: number): Promise<void> {
    return this.sleep(ms);
  }
}

/**
 * One connection instance. Owns the per-grant cached state, the capability
 * slots (grant epochs), and the AuthState surface. Reads and saves its grant
 * through the repository; builds/tears down capability instances as grants and
 * subscriptions change.
 */
class ConnectionImpl implements Connection {
  readonly auth: AuthState;

  /** Cached grant state, keyed by grant name; the source of truth is the
   *  repository, this mirror avoids an async read on every status()/getter call. */
  private readonly grantState = new Map<GrantName, GrantState>();
  /** Live credential per grant name (present ⇔ state !== "unauthorized"). */
  private readonly liveCreds = new Map<GrantName, Credential>();
  /** Grants renewed since their last grant — a second rejection degrades. */
  private readonly renewedSinceGranted = new Set<GrantName>();
  /** In-flight renewal promise per grant (single-flight coalescing). */
  private readonly renewalsInFlight = new Map<GrantName, Promise<void>>();
  /** Per-grant serialization: the tail of a promise-chain mutex, keyed by grant
   *  name. Every guardian-facing lifecycle mutation (grant, revoke, profile
   *  backfill) runs inside its grant's chain, so two overlapping mutations on the
   *  same grant apply in issue order rather than interleaving across their awaited
   *  store writes. The mutex lives on the ConnectionImpl and is keyed by grant
   *  name, so different grants — and different connections, which are distinct
   *  ConnectionImpls — serialize independently and never against each other. Keys
   *  are bounded by the descriptor's declared grants and evicted when idle. */
  private readonly grantMutex = new KeyedMutex();

  private readonly slots = new Map<Capability, CapabilitySlot>();
  private watchSubscribed = false;
  private epochCounter = 0;

  readonly id: ConnectionId;
  readonly connectionKind: string;
  readonly label: string;

  constructor(
    /** What this connection is apart from its grant, as it is kept. */
    readonly record: ConnectionRecord,
    readonly descriptor: ConnectionDescriptor,
    private readonly registry: ConnectionRegistry,
  ) {
    this.id = record.id;
    this.connectionKind = record.connectionKind;
    this.label = record.label;
    for (const cap of ["talk", "act", "watch"] as const) {
      const kind = KIND_OF[cap];
      const capDef = descriptor.capabilities[kind];
      if (!capDef) continue;
      const gated =
        kind === "watcher" && descriptor.capabilities.watcher?.subscriptionGated === true;
      this.slots.set(cap, {
        cap,
        kind,
        needs: [descriptor.grant],
        subscriptionGated: gated,
        degradation: kind === "talker" ? descriptor.capabilities.talker?.degradation : undefined,
        epoch: null,
        messageHandlers: [],
        eventHandlers: [],
      });
    }
    this.auth = new AuthStateImpl(this);
  }

  private get store(): ConnectionsRepository {
    return this.registry.getRepository();
  }

  /** Replace the kept grant with `next` of it, read and saved in one
   *  transaction. */
  private replaceGrant(next: (current: GrantValue) => GrantValue): Promise<void> {
    return this.store.update(this.id, (current) => ({ ...current, grant: next(current.grant) }));
  }
  private get log(): Logger {
    return this.registry.getLogger();
  }

  /**
   * A Talk's `history: true` is what gives its channel a `messages` port, and
   * its history feature is what answers that port. Declared apart, the two can
   * disagree: a port that fails every read, or a history no channel reaches.
   * Said loudly here, where the Talk first exists, rather than at a read.
   */
  private checkHistoryDeclared(talker: Talker): void {
    const declared = this.descriptor.capabilities.talker?.history === true;
    const offered = talker.history !== undefined;
    if (declared === offered) return;
    this.log.error("talker history flag disagrees with its history feature", {
      connectionId: this.id,
      connectionKind: this.connectionKind,
      declared,
      offered,
    });
  }

  /** Take `rec`, the grant as it is kept, rehydrate its live credential
   *  (renewing or degrading an expired one), then build every currently-unlocked
   *  capability and fire onUnlocked. Runs at connect() (no grant held), at
   *  load() and at a grant that mints the connection. */
  async hydrate(rec: GrantValue): Promise<void> {
    for (const [name, scheme] of [[this.descriptor.grant, this.descriptor.auth] as const]) {
      if (rec.state === "unauthorized") {
        this.grantState.set(name, "unauthorized");
        continue;
      }
      if (rec.state === "degraded") {
        this.grantState.set(name, "degraded");
        continue;
      }
      const persisted = rec.credential;
      if (!persisted) {
        // Invariant violation (authorized without credential): treat as degraded.
        this.grantState.set(name, "degraded");
        continue;
      }
      const cred = fromPersisted(persisted, scheme);
      if (this.isExpired(cred)) {
        await this.renewOrDegradeAtLoad(name, scheme, cred);
      } else {
        this.grantState.set(name, "authorized");
        this.liveCreds.set(name, cred);
        // Boot rehydration re-materializes custody artifacts (the tmpfs token
        // file / shell auth) for an authorized grant — the container's tmpfs is
        // wiped on restart, so a persisted grant must re-emit its artifacts in
        // process at load, not from a separate pre-boot script.
        await this.syncCustody(name, cred);
      }
    }
    this.activateAvailableCapabilities();
  }

  activateAvailableCapabilities(): void {
    if (!this.registry.capabilitiesMayActivate()) return;
    for (const slot of this.slots.values()) {
      if (this.unlocked(slot) && !slot.epoch) this.buildEpoch(slot, /* fire */ true);
    }
  }

  /** Renew each authorized grant whose credential expires within `withinMs`.
   *  Runs under the grant's lock, so it serializes with grant and revoke.
   *  Unlike the fault-driven renew, a failure here does not degrade a credential
   *  that still works: it keeps the current one and the next pass retries. A
   *  renewer that can't answer (`RenewalUnavailable`) never degrades the grant,
   *  even once the credential has expired. Only a refusal (`fix`, or any
   *  other throw) degrades, and only an already-expired credential. */
  async renewExpiring(withinMs: number): Promise<void> {
    const deadline = this.registry.now().getTime() + withinMs;
    for (const [grant, scheme] of [[this.descriptor.grant, this.descriptor.auth] as const]) {
      const cred = this.liveCreds.get(grant);
      if (!cred || cred.expiresAt === "never" || cred.expiresAt.getTime() > deadline) continue;
      await this.withGrantLock(grant, () => this.renewExpiringLocked(grant, scheme, withinMs));
    }
  }

  private async renewExpiringLocked(
    grant: GrantName,
    scheme: AuthScheme,
    withinMs: number,
  ): Promise<void> {
    // Re-read under the lock: a grant or revoke that ran while this pass
    // queued has already replaced or dropped the credential.
    const cred = this.liveCreds.get(grant);
    if (this.grantState.get(grant) !== "authorized" || !cred || cred.expiresAt === "never") return;
    if (cred.expiresAt.getTime() > this.registry.now().getTime() + withinMs) return;
    const stillCurrent = () => this.liveCreds.get(grant) === cred;

    let renewed: Credential | "needs-fix";
    try {
      renewed = await scheme.renew(cred);
    } catch (err) {
      this.log.warn("expiring-credential renew threw", {
        connectionId: this.id,
        grant,
        error: errMsg(err),
      });
      if (err instanceof RenewalUnavailable) return;
      renewed = "needs-fix";
    }
    if (!stillCurrent()) return;
    if (renewed === "needs-fix") {
      if (this.isExpired(cred)) {
        await this.degradeLocked(grant, "credential expired and renew failed", stillCurrent);
      }
      return;
    }
    const now = this.registry.now();
    await this.replaceGrant((current) => renewedGrant(current, renewed, now));
    this.liveCreds.set(grant, renewed);
    this.reconcile(grant);
    await this.syncCustody(grant, renewed);
  }

  /** At-load expired-credential handling: renew once, else degrade. */
  private async renewOrDegradeAtLoad(
    name: GrantName,
    scheme: AuthScheme,
    cred: Credential,
  ): Promise<void> {
    let renewed: Credential | "needs-fix";
    try {
      renewed = await scheme.renew(cred);
    } catch (err) {
      if (err instanceof RenewalUnavailable) {
        // The renewer couldn't answer (offline at boot, a Rome Cloud deploy).
        // Keep the grant on its expired credential; the renewal pass retries.
        this.log.warn("expired credential could not renew at load; will retry", {
          connectionId: this.id,
          grant: name,
          error: errMsg(err),
        });
        this.grantState.set(name, "authorized");
        this.liveCreds.set(name, cred);
        await this.syncCustody(name, cred);
        return;
      }
      // Load runs before any epoch exists — nothing can supersede this flow.
      await this.degradeGrant(name, `renew threw at load: ${errMsg(err)}`, () => true);
      return;
    }
    if (renewed === "needs-fix") {
      await this.degradeGrant(name, "renew returned fix at load", () => true);
      return;
    }
    // Store first (the store is authoritative) — consistent with the
    // fault-driven renew path.
    const now = this.registry.now();
    await this.replaceGrant((current) => renewedGrant(current, renewed, now));
    this.grantState.set(name, "authorized");
    this.liveCreds.set(name, renewed);
    await this.syncCustody(name, renewed);
  }

  private isExpired(cred: Credential): boolean {
    return cred.expiresAt !== "never" && cred.expiresAt.getTime() <= this.registry.now().getTime();
  }

  /** unlocked(cap) ⇔ implemented AND needs ⊆ liveGrants AND (not a gated
   *  watcher OR subscribed). */
  private unlocked(slot: CapabilitySlot): boolean {
    for (const grant of slot.needs) {
      if (this.grantState.get(grant) !== "authorized") return false;
    }
    if (slot.cap === "watch" && slot.subscriptionGated && !this.watchSubscribed) return false;
    return true;
  }

  isUnlocked(cap: Capability): boolean {
    const slot = this.slots.get(cap);
    return slot ? slot.epoch !== null : false;
  }

  state(): ConnectionState | null {
    const states = Object.values(this.grants());
    if (states.includes("degraded")) return "broken";
    return states.every((state) => state === "authorized") ? "working" : null;
  }

  status(): Record<Capability, CapabilityStatus> {
    return {
      talk: this.capStatus("talk"),
      act: this.capStatus("act"),
      watch: this.capStatus("watch"),
    };
  }

  private capStatus(cap: Capability): CapabilityStatus {
    const slot = this.slots.get(cap);
    if (!slot) return { state: "unsupported" };
    const missing = slot.needs.filter((g) => this.grantState.get(g) !== "authorized");
    if (missing.length > 0) return { state: "needs-auth", missingGrants: missing };
    if (cap === "watch" && slot.subscriptionGated && !this.watchSubscribed) {
      return { state: "needs-subscription" };
    }
    if (cap === "talk" && slot.epoch) {
      const degradation = slot.degradation?.(slot.epoch.instance as Talker);
      if (degradation) return { state: "unlocked", degradation };
    }
    return { state: "unlocked" };
  }

  withTalker<T>(call: (talker: Omit<Talker, "start" | "stop">) => T): T | undefined {
    const slot = this.slots.get("talk");
    const epoch = slot?.epoch;
    if (!slot || !epoch) return undefined;
    let answer: T;
    try {
      answer = call(epoch.instance as Talker);
    } catch (err) {
      this.handleThrownFault(slot, err, epoch);
      throw err;
    }
    if (answer instanceof Promise) {
      answer.catch((err: unknown) => this.handleThrownFault(slot, err, epoch));
    }
    return answer;
  }

  hearTalker(handler: (message: ChannelMessage) => Promise<void>): (() => void) | null {
    const slot = this.slots.get("talk");
    if (!slot || !slot.epoch) return null;
    slot.messageHandlers.push(handler);
    return () => {
      const index = slot.messageHandlers.indexOf(handler);
      if (index >= 0) slot.messageHandlers.splice(index, 1);
    };
  }

  get act(): Act | null {
    const slot = this.slots.get("act");
    if (!slot || !slot.epoch) return null;
    return this.actWrapper(slot, slot.epoch);
  }
  get watch(): Watch | null {
    const slot = this.slots.get("watch");
    if (!slot || !slot.epoch) return null;
    return this.watchWrapper(slot, slot.epoch);
  }

  private actWrapper(slot: CapabilitySlot, epoch: Epoch): Act {
    return {
      operations: () => {
        this.assertLive(epoch);
        return (epoch.instance as Actor).operations();
      },
      invoke: async (call: OperationCall): Promise<OperationResult> => {
        this.assertLive(epoch);
        try {
          return await (epoch.instance as Actor).invoke(call);
        } catch (err) {
          this.handleThrownFault(slot, err, epoch);
          throw err;
        }
      },
    };
  }

  private watchWrapper(slot: CapabilitySlot, epoch: Epoch): Watch {
    return {
      onEvent: (handler) => {
        this.assertLive(epoch);
        slot.eventHandlers.push(handler);
      },
    };
  }

  private assertLive(epoch: Epoch): void {
    if (epoch.dead) {
      throw new Error("capability relocked; re-acquire via onUnlocked");
    }
  }

  /** Build a fresh epoch for an unlocked capability: instantiate the builder,
   *  wire deliver/fault (Talker/Watcher), fire onUnlocked (when `fire`), THEN
   *  start it. The prior epoch (if any) must already be torn down.
   *
   *  Ordering matters: onUnlocked fires BEFORE startInstance so that handlers a
   *  caller registers SYNCHRONOUSLY inside its onUnlocked callback are wired
   *  into the slot before the stream starts. A Talker/Watcher whose start()
   *  delivers synchronously (e.g. flushing buffered inbound) would otherwise send
   *  into empty handler arrays and drop its first delivery. The instance already
   *  exists when onUnlocked fires, so an onUnlocked handler may send through
   *  `withTalker` before start() has run — send-before-start is permitted. */
  private buildEpoch(slot: CapabilitySlot, fire: boolean): void {
    const grant = this.descriptor.grant;
    const cred = this.liveCreds.get(grant);
    if (!cred) {
      this.log.error("buildEpoch missing live credential", {
        connectionId: this.id,
        capability: slot.cap,
        grant,
      });
      return;
    }
    const kit = this.makeKit();
    const capDef = this.descriptor.capabilities[slot.kind];
    if (!capDef) return;
    const instance = capDef.build(cred, kit);
    if (slot.kind === "talker") {
      try {
        this.checkHistoryDeclared(instance as Talker);
      } catch (err) {
        // A diagnostic that cannot run says so, and never fails the build.
        this.log.warn("could not check the talker's history flag", {
          connectionId: this.id,
          connectionKind: this.connectionKind,
          error: errMsg(err),
        });
      }
    }
    const epoch: Epoch = {
      token: ++this.epochCounter,
      instance,
      dead: false,
      backoffGen: 0,
      disconnectStreak: 0,
    };
    slot.epoch = epoch;
    slot.messageHandlers = [];
    slot.eventHandlers = [];
    // Fire onUnlocked BEFORE starting the instance so handlers registered
    // synchronously in the callback are wired when the stream starts (see the
    // method doc). A handler may also send through withTalker here — the
    // instance exists, so send-before-start works.
    if (fire) this.registry.fireUnlock(slot.cap, this);
    this.startInstance(slot, epoch);
  }

  /** Start a long-lived instance (Talker/Watcher), wiring deliver/emit into the
   *  current epoch's handler list and fault into the runtime decoration. Actor
   *  has no start(). Delivery/emit route through the SLOT so a backoff rebuild
   *  (new instance, same epoch/wrapper) keeps existing handlers wired. */
  private startInstance(slot: CapabilitySlot, epoch: Epoch): void {
    const fault = (err: StreamFault) => this.handleFault(slot, err, epoch);
    if (slot.kind === "talker") {
      (epoch.instance as Talker).start((msg) => {
        epoch.disconnectStreak = 0; // a successful delivery ends any backoff run
        for (const handler of slot.messageHandlers) {
          void handler(msg).catch((err) => {
            this.log.error("Talk onMessage handler threw", {
              connectionId: this.id,
              error: errMsg(err),
            });
          });
        }
      }, fault);
    } else if (slot.kind === "watcher") {
      (epoch.instance as Watcher).start((event) => {
        epoch.disconnectStreak = 0; // a successful delivery ends any backoff run
        for (const handler of slot.eventHandlers) {
          try {
            handler(event);
          } catch (err) {
            this.log.error("Watch onEvent handler threw", {
              connectionId: this.id,
              error: errMsg(err),
            });
          }
        }
      }, fault);
    }
  }

  /** Stop and discard a capability's current epoch (relock). Handler lists are
   *  cleared so no listeners survive into a future epoch. */
  private teardownEpoch(slot: CapabilitySlot): void {
    const epoch = slot.epoch;
    if (!epoch) return;
    epoch.dead = true;
    epoch.backoffGen++; // cancel any in-flight backoff loop
    this.stopInstance(slot, epoch);
    slot.epoch = null;
    slot.messageHandlers = [];
    slot.eventHandlers = [];
  }

  private stopInstance(slot: CapabilitySlot, epoch: Epoch): void {
    try {
      // stop() may return a promise (grammy's bot.stop()). Relock teardown is
      // fire-and-forget: swallow any async rejection so a slow/failing drain
      // during a relock never surfaces as an unhandled rejection. Graceful
      // shutdown uses stopInstanceAwaiting() instead, which awaits the drain.
      const ret =
        slot.kind === "actor"
          ? (epoch.instance as Actor).stop?.()
          : (epoch.instance as Talker | Watcher).stop();
      if (ret instanceof Promise) ret.catch((err) => this.warnStopThrew(slot, err));
    } catch (err) {
      this.warnStopThrew(slot, err);
    }
  }

  /** Await a capability instance's stop() (graceful shutdown). Unlike
   *  stopInstance, this lets an async transport drain finish before returning. */
  private async stopInstanceAwaiting(slot: CapabilitySlot, epoch: Epoch): Promise<void> {
    try {
      if (slot.kind === "actor") {
        await (epoch.instance as Actor).stop?.();
      } else {
        await (epoch.instance as Talker | Watcher).stop();
      }
    } catch (err) {
      this.warnStopThrew(slot, err);
    }
  }

  private warnStopThrew(slot: CapabilitySlot, err: unknown): void {
    this.log.warn("capability stop() threw", {
      connectionId: this.id,
      capability: slot.cap,
      error: errMsg(err),
    });
  }

  /** Tear down every capability (registry.remove). */
  teardownAll(): void {
    for (const slot of this.slots.values()) this.teardownEpoch(slot);
  }

  /** Tear down every capability, AWAITING each instance's stop() drain (graceful
   *  shutdown, registry.stopAll). Mirrors teardownEpoch's bookkeeping but blocks
   *  on the transport drain. */
  async teardownAllAwaiting(): Promise<void> {
    for (const slot of this.slots.values()) {
      const epoch = slot.epoch;
      if (!epoch) continue;
      epoch.dead = true;
      epoch.backoffGen++; // cancel any in-flight backoff loop
      await this.stopInstanceAwaiting(slot, epoch);
      slot.epoch = null;
      slot.messageHandlers = [];
      slot.eventHandlers = [];
    }
  }

  /** Re-evaluate every capability that needs `grant` (or all, when grant is
   *  undefined — e.g. subscription change touching watch). Locked→unlocked
   *  builds a fresh epoch (fires onUnlocked); unlocked→locked tears down;
   *  still-unlocked with a NEW credential set rebuilds (stop then build, fires).
   *  kit.persist does NOT route here — it never rebuilds. */
  private reconcile(grant: GrantName | undefined): void {
    if (!this.registry.capabilitiesMayActivate()) return;
    for (const slot of this.slots.values()) {
      if (grant !== undefined && !slot.needs.includes(grant)) continue;
      const shouldBeUnlocked = this.unlocked(slot);
      const isUnlocked = slot.epoch !== null;
      if (shouldBeUnlocked && !isUnlocked) {
        this.buildEpoch(slot, /* fire */ true);
      } else if (!shouldBeUnlocked && isUnlocked) {
        this.teardownEpoch(slot);
      } else if (shouldBeUnlocked && isUnlocked) {
        // Still unlocked but a grant in `needs` got a NEW credential — rebuild.
        this.teardownEpoch(slot);
        this.buildEpoch(slot, /* fire */ true);
      }
    }
  }

  /** The kit a capability's build() gets. persist writes the connection's one
   *  grant. */
  private makeKit(): RuntimeKit {
    return {
      connectionId: this.id,
      registerIngress: (handler) => this.registry.registerIngress(this.id, handler),
      persist: (material: SecretRecord) => this.persistMaterial(this.descriptor.grant, material),
    };
  }

  /** Write-through custody: update the grant's stored credential material in
   *  place, and the in-memory Credential so the NEXT build sees it. No epoch
   *  rebuild, no state change, no onUnlocked. Store first (the store
   *  is authoritative): a failed durable write throws before the in-memory
   *  liveCreds swap, so the mirror keeps the prior material — the next build
   *  cannot see a rotation that never persisted. */
  private async persistMaterial(grant: GrantName, material: SecretRecord): Promise<void> {
    const current = this.liveCreds.get(grant);
    const expiresAt = current?.expiresAt ?? "never";
    const next: Credential = { material, expiresAt };
    await this.replaceGrant((current) => ({
      ...current,
      credential: toPersisted(next),
    }));
    this.liveCreds.set(grant, next);
  }

  /** Materialize a grant's custody artifacts (token files, shell auth) from its
   *  live credential material + persisted profile. Fire-and-forget: a failure is
   *  logged and swallowed so it can never fail the transition that triggered it —
   *  the store is authoritative and the next transition or boot re-syncs. No-op
   *  for a descriptor with no custody, or an external-custody credential (a
   *  function material has no on-disk secret to mirror). Reads the profile from
   *  the store, which was just written in the same transition, so custody always
   *  reflects the current grant outcome. */
  private async syncCustody(grant: GrantName, cred: Credential): Promise<void> {
    const custody = this.descriptor.custody;
    if (!custody || typeof cred.material === "function") return;
    const material = cred.material;
    try {
      const grant = await this.store.grantOf(this.id);
      await custody.sync(material, grant?.profile ?? {});
    } catch (err) {
      this.log.warn("custody sync failed", {
        connectionId: this.id,
        grant,
        error: errMsg(err),
      });
    }
  }

  /** Clear a grant's custody artifacts (revoke or degrade). Fire-and-forget with
   *  the same swallow-and-log discipline as {@link syncCustody}. */
  private async clearCustody(grant: GrantName): Promise<void> {
    const custody = this.descriptor.custody;
    if (!custody) return;
    try {
      await custody.clear();
    } catch (err) {
      this.log.warn("custody clear failed", {
        connectionId: this.id,
        grant,
        error: errMsg(err),
      });
    }
  }

  /** Run `fn` inside the grant's mutex: it starts only once every
   *  previously-enqueued mutation on the SAME grant has settled, so lifecycle
   *  mutations on one grant apply in issue order (FIFO) — a later-issued
   *  operation queues behind an in-flight earlier one and wins by running last.
   *
   *  A mutation that legitimately rejects (e.g. a store write failure) neither
   *  poisons the next mutation on the grant nor surfaces as an unhandled rejection
   *  (the keyed mutex releases either way); the original result/rejection is still
   *  returned to THIS caller unchanged. */
  /** The scheme of `grant`, or undefined when it is not the connection's grant. */
  private schemeOf(grant: GrantName): AuthScheme | undefined {
    return grant === this.descriptor.grant ? this.descriptor.auth : undefined;
  }

  private withGrantLock<T>(grant: GrantName, fn: () => Promise<T>): Promise<T> {
    return this.grantMutex.runExclusive(grant, fn);
  }

  grants(): Record<GrantName, GrantState> {
    const out: Record<GrantName, GrantState> = {};
    for (const name of [this.descriptor.grant]) {
      out[name] = this.grantState.get(name) ?? "unauthorized";
    }
    return out;
  }

  /** The registry's transactional `grant` for an existing connection: run its
   *  durable write (`commit`), then bring the grant live in memory, as ONE step
   *  under the per-grant lock. Holding the lock across the write is what keeps a
   *  renewal on the same grant from writing its older credential over this
   *  grant: the renewal either finishes first or starts after. A failed
   *  write throws to the caller; a failed activation goes to `onActivationError`
   *  (the grant is durable either way). */
  commitAndActivateGrant(
    grant: GrantName,
    cred: Credential,
    commit: () => void,
    onActivationError: (err: unknown) => void,
  ): Promise<void> {
    return this.withGrantLock(grant, async () => {
      commit();
      try {
        await this.activateGrantInMemory(grant, cred);
      } catch (err) {
        onActivationError(err);
      }
    });
  }

  private async activateGrantInMemory(grant: GrantName, cred: Credential): Promise<void> {
    this.grantState.set(grant, "authorized");
    this.liveCreds.set(grant, cred);
    this.renewedSinceGranted.delete(grant);
    this.reconcile(grant);
    await this.syncCustody(grant, cred);
  }

  revoke(grant: GrantName, opts: { inTx?: (tx: DrizzleTx) => void } = {}): Promise<void> {
    return this.withGrantLock(grant, () => this.revokeLocked(grant, opts));
  }

  /** Remove this connection and its grant in one transaction that raises
   *  disconnected, then drop the grant in memory, stop every capability and
   *  clear the custody artifacts. The store comes first, so a failed write
   *  throws with nothing changed in memory. */
  disconnect(grant: GrantName): Promise<void> {
    return this.withGrantLock(grant, async () => {
      const connection = { id: this.id, connectionKind: this.connectionKind };
      this.store.transaction((tx) => {
        this.store.remove(tx, this.id);
        this.registry.raise(tx, { kind: "disconnected", connection });
      });
      this.grantState.set(grant, "unauthorized");
      this.liveCreds.delete(grant);
      this.renewedSinceGranted.delete(grant);
      this.teardownAll();
      await this.clearCustody(grant);
    });
  }

  private async revokeLocked(
    grant: GrantName,
    opts: { inTx?: (tx: DrizzleTx) => void },
  ): Promise<void> {
    const scheme = this.schemeOf(grant);
    if (!scheme) throw new Error(`connection "${this.id}" has no grant "${grant}"`);
    // Store first (the store is authoritative): a failed durable
    // write propagates to the caller with nothing revoked in memory — the grant
    // stays authorized and its epoch alive.
    // A revoked grant holds nothing, so it carries no stale identity.
    const connection = { id: this.id, connectionKind: this.connectionKind };
    await this.store.update(
      this.id,
      (current) => ({ ...current, grant: NO_GRANT }),
      (tx) => {
        this.registry.raise(tx, { kind: "revoked", connection });
        opts.inTx?.(tx);
      },
    );
    this.grantState.set(grant, "unauthorized");
    this.liveCreds.delete(grant);
    this.renewedSinceGranted.delete(grant);
    this.reconcile(grant);
    await this.clearCustody(grant);
  }

  async setWatchSubscribed(subscribed: boolean): Promise<void> {
    if (this.watchSubscribed === subscribed) return;
    this.watchSubscribed = subscribed;
    // Only the watch slot is affected; reconcile all (grant=undefined) is fine —
    // non-watch slots never depend on the subscription, so they no-op.
    const slot = this.slots.get("watch");
    if (!slot) return;
    const shouldBeUnlocked = this.unlocked(slot);
    const isUnlocked = slot.epoch !== null;
    if (shouldBeUnlocked && !isUnlocked) this.buildEpoch(slot, true);
    else if (!shouldBeUnlocked && isUnlocked) this.teardownEpoch(slot);
  }

  /** Faults reported through a Talker/Watcher start() fault channel. */
  private handleFault(slot: CapabilitySlot, err: StreamFault, source: Epoch): void {
    // A fault callback can outlive its epoch: transports fire terminal errors
    // from in-flight work while teardown's stopInstance is still draining.
    // Acting on a fault from a discarded epoch would mutate grant state the
    // discard already settled (e.g. flipping a revoked grant unauthorized→
    // degraded), so only the CURRENT, live epoch's faults run the grant flow.
    if (source.dead || slot.epoch !== source) return;
    if (err instanceof Disconnected) {
      this.runFaultFlow(slot, "Disconnected", this.handleDisconnected(slot, err));
      return;
    }
    this.runFaultFlow(slot, "CredentialRejected", this.handleCredentialRejected(slot, err, source));
  }

  /** Faults thrown from act.invoke or inside withTalker. The caller still gets
   *  the original error; the grant flow runs async. */
  private handleThrownFault(slot: CapabilitySlot, err: unknown, source: Epoch): void {
    if (source.dead || slot.epoch !== source) return; // see handleFault
    if (err instanceof CredentialRejected) {
      this.runFaultFlow(
        slot,
        "CredentialRejected",
        this.handleCredentialRejected(slot, err, source),
      );
    }
    // Any other thrown error is a plain application error — not our concern.
  }

  /** Fire-and-forget a fault-driven grant flow, catching any rejection (e.g. a
   *  transient store write failure inside renew/degrade). Without this a
   *  rejected store write would surface as an unhandled promise rejection and,
   *  under Node's default --unhandled-rejections=throw, crash the host. A store
   *  blip must degrade gracefully, not take the process down. */
  private runFaultFlow(slot: CapabilitySlot, kind: string, flow: Promise<void>): void {
    void flow.catch((err) => {
      this.log.error("fault flow failed", {
        connectionId: this.id,
        capability: slot.cap,
        fault: kind,
        error: errMsg(err),
      });
    });
  }

  /** Resolve the suspect grant(s) and run renew-once-then-degrade on each. */
  private async handleCredentialRejected(
    slot: CapabilitySlot,
    err: CredentialRejected,
    source: Epoch,
  ): Promise<void> {
    // The invocation-time guard in handleFault/handleThrownFault only covers the
    // pre-callback window. This flow then awaits (renewalsInFlight join, store
    // writes, scheme.renew), and a grant can complete in ANY of those gaps —
    // tearing down `source` and building a fresh epoch on a fresh credential.
    // Acting after that would clobber the fresh grant (persist `degraded` over a
    // just-authorized grant), so every state application downstream re-checks
    // this predicate immediately before writing.
    const stillCurrent = () => !source.dead && slot.epoch === source;
    const targets = err.grant !== undefined ? [err.grant] : [this.descriptor.grant];
    for (const grant of targets) {
      await this.renewOnceOrDegrade(grant, err, stillCurrent);
    }
  }

  /** Single-flight renew-once-then-degrade for one grant. `stillCurrent` reports
   *  whether the faulting epoch is still the slot's live epoch; the flow aborts
   *  (no-op) the moment it turns false — a superseded fault must never mutate
   *  the fresh grant's grant state. */
  private renewOnceOrDegrade(
    grant: GrantName,
    cause: CredentialRejected,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const existing = this.renewalsInFlight.get(grant);
    if (existing) return existing;
    const scheme = this.schemeOf(grant);
    if (!scheme) return Promise.resolve();
    const promise = (async () => {
      if (!stillCurrent()) return;
      // Already renewed since last grant → degrade instead of renewing again.
      if (this.renewedSinceGranted.has(grant)) {
        await this.degradeGrant(grant, `credential rejected again: ${cause.message}`, stillCurrent);
        return;
      }
      const cred = this.liveCreds.get(grant);
      if (!cred) {
        await this.degradeGrant(grant, "credential rejected with no live credential", stillCurrent);
        return;
      }
      this.renewedSinceGranted.add(grant);
      await this.renewGrant(
        grant,
        scheme,
        cred,
        `credential rejected: ${cause.message}`,
        stillCurrent,
      );
    })().finally(() => {
      this.renewalsInFlight.delete(grant);
    });
    this.renewalsInFlight.set(grant, promise);
    return promise;
  }

  /** Attempt a renewal; on success persist + rebuild, on "needs-fix"/throw degrade.
   *
   *  Store first on the success branch (the store is authoritative).
   *  If the durable write throws, the renewal is NOT applied: the mirror is
   *  untouched, so the grant stays authorized with its PRIOR (still-live)
   *  credential and its epoch alive — a failed renew write cannot half-apply a
   *  new credential. The throw propagates up through renewOnceOrDegrade into the
   *  fault flow, where runFaultFlow's .catch swallows it (a store blip must not
   *  crash the process). Note `renewOnceOrDegrade` sets `renewedSinceGranted`
   *  BEFORE calling us, and we deliberately leave it set on a failed write: the
   *  renew was genuinely attempted, so the next CredentialRejected degrades
   *  rather than looping renew attempts against a flaky store. */
  private async renewGrant(
    grant: GrantName,
    scheme: AuthScheme,
    cred: Credential,
    reason: string,
    stillCurrent: () => boolean,
  ): Promise<void> {
    let renewed: Credential | "needs-fix";
    try {
      renewed = await scheme.renew(cred);
    } catch (err) {
      await this.degradeGrant(grant, `renew threw (${reason}): ${errMsg(err)}`, stillCurrent);
      return;
    }
    // scheme.renew is the flow's longest await, and runs outside the grant's
    // lock so a slow renewer never holds up a grant or a disconnect. A
    // grant completing during it superseded this fault, so the result is
    // applied under the lock, and only while the faulting epoch is current.
    if (renewed === "needs-fix") {
      await this.degradeGrant(grant, `renew returned fix (${reason})`, stillCurrent);
      return;
    }
    await this.withGrantLock(grant, async () => {
      if (!stillCurrent()) return;
      const now = this.registry.now();
      await this.replaceGrant((current) => renewedGrant(current, renewed, now));
      this.grantState.set(grant, "authorized");
      this.liveCreds.set(grant, renewed);
      this.reconcile(grant);
      await this.syncCustody(grant, renewed);
    });
  }

  /** Break the connection: save its grant degraded with `reason`, raising
   *  broken, then relock every capability that needs it. The stored credential
   *  is kept, inert, until a fix replaces it. Only the in-memory live
   *  credential is dropped, so nothing can use it.
   *
   *  Runs under the grant's lock, so no grant or revoke can land between
   *  the `stillCurrent` check and the write: a fault flow that a grant
   *  superseded drops its break instead of writing it. The store comes first,
   *  so a failed write throws before any in-memory change, and the next
   *  rejection retries. Load-time callers, which run before any epoch exists,
   *  pass `() => true`. */
  private degradeGrant(grant: GrantName, reason: string, stillCurrent: () => boolean) {
    return this.withGrantLock(grant, () => this.degradeLocked(grant, reason, stillCurrent));
  }

  private async degradeLocked(
    grant: GrantName,
    reason: string,
    stillCurrent: () => boolean,
  ): Promise<void> {
    if (!stillCurrent()) return;
    const now = this.registry.now();
    const connection = { id: this.id, connectionKind: this.connectionKind };
    await this.store.update(
      this.id,
      (current) => ({ ...current, grant: brokenGrant(current.grant, reason, now) }),
      (tx) => this.registry.raise(tx, { kind: "broken", connection, reason }),
    );
    this.grantState.set(grant, "degraded");
    this.liveCreds.delete(grant);
    for (const slot of this.slots.values()) {
      if (slot.needs.includes(grant) && slot.epoch) this.teardownEpoch(slot);
    }
    this.log.warn("grant degraded", { connectionId: this.id, grant, reason });
    // Clear the grant's custody artifacts: an out-of-process consumer must lose
    // the dead token rather than keep retrying it until the guardian reconnects.
    await this.clearCustody(grant);
  }

  /** Disconnected: never touches grant state. Backoff, then rebuild the SAME
   *  epoch's instance with the grant's CURRENT live credentials (so a
   *  kit.persist that happened mid-run is reflected), swapping the
   *  current-instance slot so the public wrapper survives. No onUnlocked
   *  re-fire. Backoff resets on the next successful build+start after a full
   *  wait. */
  private async handleDisconnected(slot: CapabilitySlot, _err: Disconnected): Promise<void> {
    const epoch = slot.epoch;
    if (!epoch || epoch.dead) return;
    const gen = ++epoch.backoffGen;
    const { baseMs, maxMs } = this.registry.getBackoff();
    // Wait exponent = the number of consecutive Disconnected faults so far.
    // First fault waits base·2^0, second consecutive waits base·2^1, etc. The
    // streak is reset to 0 by a successful delivery (startInstance), NOT by a
    // rebuild — a rebuild that immediately re-faults keeps escalating the wait.
    const attempt = epoch.disconnectStreak;
    epoch.disconnectStreak = attempt + 1;
    const waitMs = Math.min(baseMs * 2 ** attempt, maxMs);
    // Stop the current (faulted) instance before waiting.
    this.stopInstance(slot, epoch);
    await this.registry.doSleep(waitMs);
    if (epoch.dead || epoch.backoffGen !== gen) return; // superseded/relocked
    try {
      const capDef = this.descriptor.capabilities[slot.kind];
      if (!capDef) return;
      const kit = this.makeKit();
      // Read the CURRENT live credential, not the frozen epoch.creds: kit.persist
      // replaces the liveCreds entry in place (no epoch rebuild), so a backoff
      // rebuild must pick up the post-persist material — otherwise write-through
      // custody (Baileys key rotation) is defeated on the next reconnect.
      const grant = this.descriptor.grant;
      const cred = this.liveCreds.get(grant);
      if (!cred) {
        // The grant went away under us (relock raced the wait) — abandon this
        // rebuild; the relock already tore the epoch down.
        this.log.warn("Disconnected rebuild missing live credential; abandoning", {
          connectionId: this.id,
          capability: slot.cap,
          grant,
        });
        return;
      }
      const instance = capDef.build(cred, kit);
      epoch.instance = instance;
      this.startInstance(slot, epoch);
    } catch (err) {
      this.log.warn("Disconnected rebuild threw; will retry on next fault", {
        connectionId: this.id,
        capability: slot.cap,
        error: errMsg(err),
      });
    }
  }
}

/** AuthState is a thin façade over the owning ConnectionImpl. */
class AuthStateImpl implements AuthState {
  constructor(private readonly conn: ConnectionImpl) {}
  grants(): Record<GrantName, GrantState> {
    return this.conn.grants();
  }
  revoke(grant: GrantName): Promise<void> {
    return this.conn.revoke(grant);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
