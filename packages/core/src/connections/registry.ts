// Connection lifecycle registry. Messaging model: docs/concepts/messaging.md.

import type { DrizzleTx } from "../db/index.js";
import { KeyedMutex } from "../lib/keyed-mutex.js";
import { createLogger, type Logger } from "../logger.js";
import type { ConnectionRecord, GrantLedger, GrantRecord, PersistedCredential } from "./ledger.js";
import { isTransactionalLedger, type TransactionalGrantLedger } from "./ledger-db.js";
import {
  CredentialRejected,
  Disconnected,
  DuplicateServiceConnectionsError,
  ServiceConnectionWriteConflict,
} from "./errors.js";
import type {
  Act,
  Actor,
  AuthScheme,
  AuthState,
  Capability,
  CapabilityStatus,
  Connection,
  ConnectionDescriptor,
  ConnectionId,
  Credential,
  GrantName,
  GrantState,
  InboundMessage,
  OperationCall,
  OperationResult,
  ProfileRecord,
  RuntimeKit,
  SecretRecord,
  StreamFault,
  Talk,
  TalkFeatureMap,
  TalkFeatureName,
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

export interface ConnectionRegistryDeps {
  ledger: GrantLedger;
  logger?: Logger;
  /** Injectable clock; defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Backoff bounds for Disconnected rebuilds. */
  backoff?: { baseMs: number; maxMs: number };
  /** Injectable sleep for Disconnected backoff waits; defaults to real timers. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BACKOFF = { baseMs: 1_000, maxMs: 60_000 };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Persist a live Credential's envelope. External-custody credentials (function
 *  material) persist as `{ kind: "external" }` — the ledger stores no secret.
 *  Exported so the pre-load providerAccounts reconciler, which writes the ledger
 *  directly (before the registry loads), shares this one envelope transform. */
export function toPersisted(cred: Credential): PersistedCredential {
  if (typeof cred.material === "function") {
    return { material: { kind: "external" }, expiresAt: cred.expiresAt };
  }
  return { material: { kind: "inline", record: cred.material }, expiresAt: cred.expiresAt };
}

/** The ledger patch that authorizes a grant with a freshly conferred credential
 *  (+ optional profile). Shared by the in-place `applyNewCredential` path and the
 *  transactional `confer` path so both write an identical row. */
function conferralPatch(
  now: Date,
  cred: Credential,
  profile?: ProfileRecord,
): Partial<Pick<GrantRecord, "state" | "credential" | "profile" | "conferredAt" | "degraded">> {
  return {
    state: "authorized",
    credential: toPersisted(cred),
    // Written in the SAME update as the credential. Only patched
    // when the conferral supplied one, so an import with no identity to record
    // leaves any existing profile untouched rather than wiping it.
    ...(profile !== undefined ? { profile } : {}),
    conferredAt: now,
    degraded: undefined,
  };
}

/** Rehydrate a live Credential from a persisted envelope. Inline custody hands
 *  back the stored record; external custody re-wraps `resolveExternal` — never
 *  confers. A `{ kind: "external" }` row without a resolver is a descriptor bug. */
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

/** Stable JSON of a credential's inline material, for idempotent-import diffing.
 *  Function (external) material is never compared — always treated as changed. */
function materialFingerprint(material: SecretRecord): string {
  const keys = Object.keys(material).sort();
  return JSON.stringify(keys.map((k) => [k, material[k]]));
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
  messageHandlers: Array<(msg: InboundMessage) => Promise<void>>;
  eventHandlers: Array<(event: WatchEvent) => void>;
}

/** A registered descriptor plus its precomputed capability metadata. */
interface RegisteredDescriptor {
  readonly descriptor: ConnectionDescriptor;
}

export class ConnectionRegistry {
  private readonly ledger: GrantLedger;
  private readonly log: Logger;
  private readonly clock: () => Date;
  private readonly backoff: { baseMs: number; maxMs: number };
  private readonly sleep: (ms: number) => Promise<void>;

  private readonly descriptors = new Map<string, RegisteredDescriptor>();
  private readonly connections = new Map<ConnectionId, ConnectionImpl>();
  private readonly unlockHandlers: Record<Capability, Array<(conn: Connection) => void>> = {
    talk: [],
    act: [],
    watch: [],
  };
  /** Per-(service, grant) critical-section chains for composite ROUTE ceremonies
   *  — a mutex keyed by `${service}\u0000${grant}`.
   *  See {@link withGrantSection}. This is the registry-owned home of the
   *  serialization the two hand-rolled route mutexes (email, telegram-user) used
   *  to own; keys are bounded by the registered services × their grants and
   *  evicted when idle. */
  private readonly sectionMutex = new KeyedMutex();
  /** Serializes every possible Service-connection mint path. Database
   *  uniqueness remains the cross-process backstop. */
  private readonly connectionMutex = new KeyedMutex();
  private readonly ingressHandlers = new Map<ConnectionId, (input: unknown) => Promise<unknown>>();
  private capabilityActivationPaused = false;

  constructor(deps: ConnectionRegistryDeps) {
    this.ledger = deps.ledger;
    this.log = deps.logger ?? createLogger("connections");
    this.clock = deps.clock ?? (() => new Date());
    this.backoff = deps.backoff ?? DEFAULT_BACKOFF;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Declare a service integration. Boot-time only. Validates that every
   *  capability's `needs` is a subset of the declared grants and that the
   *  service name is unique. */
  register(desc: ConnectionDescriptor): void {
    if (this.descriptors.has(desc.service)) {
      throw new Error(`duplicate connection descriptor for service "${desc.service}"`);
    }
    const declared = new Set(Object.keys(desc.auth));
    for (const kind of ["talker", "actor", "watcher"] as const) {
      const cap = desc.capabilities[kind];
      if (!cap) continue;
      for (const grant of cap.needs) {
        if (!declared.has(grant)) {
          throw new Error(
            `capability "${kind}" of service "${desc.service}" needs undeclared grant "${grant}"`,
          );
        }
      }
    }
    this.descriptors.set(desc.service, { descriptor: desc });
  }

  /** True iff a descriptor has been registered for `service`. Lets callers
   *  (settings-import's zero-grant path) skip services this registry does not
   *  know about — e.g. a test that registers only a subset. */
  isRegistered(service: string): boolean {
    return this.descriptors.has(service);
  }

  /** Read the registered integration declaration. Generic identity surfaces use
   *  its reviveProfile hook instead of inspecting integration-owned profile keys. */
  getDescriptor(service: string): ConnectionDescriptor | null {
    return this.descriptors.get(service)?.descriptor ?? null;
  }

  /** Every registered service name — the offerable catalog. Lets the connections
   *  API list services a guardian could connect that have no connection row yet. */
  registeredServices(): string[] {
    return Array.from(this.descriptors.keys());
  }

  /** Reconstruct every persisted connection at boot. Reads the ledger, rebuilds
   *  Connection objects for known services (unknown services are logged and
   *  skipped), builds capabilities for grants that are live, and fires
   *  onUnlocked for each. Expired credentials are renewed once or degraded. */
  async load(options: { deferCapabilities?: boolean } = {}): Promise<void> {
    this.capabilityActivationPaused = options.deferCapabilities ?? false;
    const records = await this.ledger.listConnections();
    for (const rec of records) {
      const registered = this.descriptors.get(rec.service);
      if (!registered) {
        this.log.warn("Skipping connection for unregistered service", {
          connectionId: rec.id,
          service: rec.service,
        });
        continue;
      }
      const conn = new ConnectionImpl(rec.id, rec.service, rec.label, registered.descriptor, this);
      this.connections.set(rec.id, conn);
      await conn.hydrate();
    }
  }

  /** Start every capability hydrated while boot activation was deferred. The
   * startup cutover uses this barrier so no provider transport can observe
   * pre-cutover settings state. */
  startCapabilities(): void {
    this.capabilityActivationPaused = false;
    for (const connection of this.connections.values()) {
      connection.activateAvailableCapabilities();
    }
  }

  capabilitiesMayActivate(): boolean {
    return !this.capabilityActivationPaused;
  }

  /** Mint a new Connection from a registered descriptor. Persists the record,
   *  makes sure every declared grant row exists ("unauthorized"), and builds any
   *  zero-grant capabilities immediately (epoch from birth). */
  async connect(service: string, label?: string): Promise<Connection> {
    return this.connectionMutex.runExclusive(service, async () => {
      const registered = this.descriptors.get(service);
      if (!registered) throw new Error(`no registered descriptor for service "${service}"`);
      const existing = this.find(service);
      if (existing.length > 0) {
        throw new DuplicateServiceConnectionsError([
          { service, connectionIds: existing.map((connection) => connection.id) },
        ]);
      }

      const id = crypto.randomUUID();
      const createdAt = this.clock();
      const record = { id, service, label: label ?? service, createdAt };
      try {
        await this.createConnectionWithGrants(record, Object.keys(registered.descriptor.auth));
      } catch (error) {
        if (error instanceof ServiceConnectionWriteConflict) {
          throw await this.duplicateServiceError(service);
        }
        throw error;
      }
      const conn = new ConnectionImpl(id, service, label ?? service, registered.descriptor, this);
      this.connections.set(id, conn);
      await conn.hydrate();
      return conn;
    });
  }

  /** Persist a connection and all of its initial grant placeholders as one
   *  durable unit. Production ledgers use the same transaction seam as
   *  confer(); the compensating fallback keeps lightweight test ledgers from
   *  stranding a connection row if their grant initialization fails. */
  private async createConnectionWithGrants(
    record: ConnectionRecord,
    grants: GrantName[],
  ): Promise<void> {
    const ledger = this.ledger;
    if (isTransactionalLedger(ledger)) {
      ledger.runInTransaction((tx) => {
        ledger.writeConnection(tx, record);
        for (const grant of grants) ledger.writeEnsureGrant(tx, record.id, grant);
      });
      return;
    }

    await ledger.createConnection(record);
    try {
      for (const grant of grants) await ledger.ensureGrant(record.id, grant);
    } catch (error) {
      try {
        await ledger.deleteConnection(record.id);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Failed to initialize connection "${record.id}" and remove its partial record`,
        );
      }
      throw error;
    }
  }

  private async duplicateServiceError(service: string): Promise<DuplicateServiceConnectionsError> {
    const records = await this.ledger.listConnections();
    return new DuplicateServiceConnectionsError([
      {
        service,
        connectionIds: records
          .filter((record) => record.service === service)
          .map((record) => record.id),
      },
    ]);
  }

  get(id: ConnectionId): Connection {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection "${id}"`);
    return conn;
  }

  all(): Connection[] {
    return Array.from(this.connections.values());
  }

  /** Convenience: every loaded connection of a service. */
  find(service: string): Connection[] {
    return this.all().filter((c) => c.service === service);
  }

  /** Stop every live capability instance across every connection WITHOUT
   *  deleting connections or touching grant state — the graceful-shutdown
   *  counterpart to the adapter `stop()` loop. Epochs are torn down (each
   *  Talker/Watcher `stop()` is called and AWAITED); the ledger is untouched, so
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
   *  `opts.inTx` is an optional caller participant (the `confer` seam,
   *  mirrored for teardown) enlisted in the SAME transaction as the connection/
   *  grant deletes — e.g. the guardian channel-mapping cleanup, so it can never
   *  be left stranded by a failure after the connection is already committed as
   *  deleted. A participant requires a transactional ledger. The in-memory
   *  teardown (`teardownAll`) and map eviction run only AFTER that transaction
   *  commits. */
  async remove(id: ConnectionId, opts: { inTx?: (tx: DrizzleTx) => void } = {}): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) throw new Error(`unknown connection "${id}"`);
    await this.connectionMutex.runExclusive(conn.service, async () => {
      const current = this.connections.get(id);
      if (!current) throw new Error(`unknown connection "${id}"`);
      if (opts.inTx) {
        await this.txLedger.deleteConnection(id, opts.inTx);
      } else {
        await this.ledger.deleteConnection(id);
      }
      current.teardownAll();
      this.connections.delete(id);
    });
  }

  /** The terminal conferral write: authorize `grant` with a proven
   *  credential + profile, minting the addressed placeholder connection when it
   *  has no row yet, and running the caller's participant (`opts.inTx` — the
   *  guardian channel mapping) — ALL inside ONE transaction. A participant
   *  failure rolls back the credential AND the mint together, so a failed
   *  conferral leaves zero residual state (the partial-write fix).
   *
   *  The adapter is started AFTER the commit, deliberately outside the
   *  transaction (a live socket cannot be rolled back): a start failure is
   *  logged, not fatal — the grant is durably authorized and its mapping
   *  consistent, so reconcile/boot brings the adapter up. That degraded state is
   *  never the "success and failure at once" a partial write produced.
   *
   *  `connectionId` addresses an existing connection (fails if it vanished
   *  mid-setup rather than resurrecting into `find()[0]`); omit it for an
   *  offerable placeholder (reuse the first existing connection of the service,
   *  else mint one). This owns the resolve/mint the manager's terminal write did
   *  inline before. */
  async confer(
    service: string,
    connectionId: ConnectionId | undefined,
    grant: GrantName,
    credential: Credential,
    profile: ProfileRecord | undefined,
    opts: { inTx?: (tx: DrizzleTx) => void } = {},
  ): Promise<Connection> {
    try {
      return await this.connectionMutex.runExclusive(service, () =>
        this.conferExclusive(service, connectionId, grant, credential, profile, opts),
      );
    } catch (error) {
      if (error instanceof ServiceConnectionWriteConflict) {
        throw await this.duplicateServiceError(service);
      }
      throw error;
    }
  }

  private async conferExclusive(
    service: string,
    connectionId: ConnectionId | undefined,
    grant: GrantName,
    credential: Credential,
    profile: ProfileRecord | undefined,
    opts: { inTx?: (tx: DrizzleTx) => void },
  ): Promise<Connection> {
    const registered = this.descriptors.get(service);
    let conn: ConnectionImpl | undefined = connectionId
      ? this.connections.get(connectionId)
      : (this.find(service)[0] as ConnectionImpl | undefined);
    if (connectionId && !conn) {
      throw new Error(`Connection "${connectionId}" no longer exists; setup cannot confer.`);
    }
    const minting = !conn;
    if (minting && !registered) {
      throw new Error(`no registered descriptor for service "${service}"`);
    }

    const id = conn?.id ?? crypto.randomUUID();
    const createdAt = this.clock();
    const patch = conferralPatch(this.now(), credential, profile);
    const ledger = this.txLedger;

    // One transaction spanning every durable write of the conferral: mint (if a
    // placeholder), the credential/profile, and the caller's participant.
    ledger.runInTransaction((tx) => {
      if (minting) {
        ledger.writeConnection(tx, { id, service, label: service, createdAt });
        for (const name of Object.keys(registered!.descriptor.auth)) {
          ledger.writeEnsureGrant(tx, id, name);
        }
      }
      ledger.writeGrant(tx, id, grant, patch);
      opts.inTx?.(tx);
    });

    // Committed — ledger + mapping are consistent. Bring the adapter live;
    // best-effort per the doc comment. A minted connection hydrates exactly as
    // it would at boot (rebuilds the epoch from the just-persisted grant); an
    // existing one activates just this grant in memory.
    try {
      if (minting) {
        conn = new ConnectionImpl(id, service, service, registered!.descriptor, this);
        this.connections.set(id, conn);
        await conn.hydrate();
      } else {
        await conn!.activatePersistedGrant(grant, credential);
      }
    } catch (err) {
      this.log.error("conferral committed but adapter activation failed", {
        service,
        connectionId: id,
        grant,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return conn as Connection;
  }

  /** The ledger viewed as transaction-capable — required by `confer`. Throws for
   *  the in-memory test fakes, which never reach `confer`. */
  private get txLedger(): TransactionalGrantLedger {
    if (!isTransactionalLedger(this.ledger)) {
      throw new Error("confer() requires a transactional ledger");
    }
    return this.ledger;
  }

  /** Headless conferral: skip confer(), inject a caller-supplied credential.
   *  The settings-import / API-shim path (phase 3). Idempotent: re-importing
   *  identical inline material over an authorized grant is a no-op.
   *
   *  `profile` is the non-secret conferral outcome: when supplied it
   *  is written to the grant row in the SAME update as the credential — there is
   *  no separate profile setter, so an authorized grant can never be observed
   *  with a missing-but-expected or previous-conferral profile. Callers with no
   *  identity to record (channel imports) omit it, leaving any existing profile
   *  untouched. */
  async importCredential(
    connectionId: ConnectionId,
    grant: GrantName,
    credential: Credential,
    profile?: ProfileRecord,
  ): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`unknown connection "${connectionId}"`);
    await conn.importCredential(grant, credential, profile);
  }

  /** Fill a MISSING profile on an already-authorized/degraded grant WITHOUT
   *  touching the credential or rebuilding the grant epoch — the boot bridge's
   *  profile-only backfill. The credential column is
   *  never in the patch, so a bridge-era install that connected before profiles
   *  existed gains its identity with no credential write and no onUnlocked. */
  async backfillProfile(
    connectionId: ConnectionId,
    grant: GrantName,
    profile: ProfileRecord,
  ): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`unknown connection "${connectionId}"`);
    await conn.backfillProfile(grant, profile);
  }

  /** In-memory subscription gate for subscription-gated Watchers (phase 6
   *  persists real subscription state). Transitions build/teardown the watch
   *  epoch and fire onUnlocked exactly like a grant change. */
  async setWatchSubscribed(connectionId: ConnectionId, subscribed: boolean): Promise<void> {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`unknown connection "${connectionId}"`);
    await conn.setWatchSubscribed(subscribed);
  }

  /** Run a composite lifecycle ceremony inside the registry-owned critical
   *  section for `(service, grant)`: it starts only once every previously
   *  enqueued section on the SAME (service, grant) has settled, so overlapping
   *  route ceremonies queue (FIFO) instead of interleaving. This is the scoped
   *  primitive channel routes wrap a multi-step sequence in — consume a pending
   *  login attempt then confer; cancel then revoke; write a settings row, confer,
   *  and compensate on failure.
   *
   *  It is keyed by (service, grant), not by connection id, on purpose: a connect
   *  ceremony mints its connection *inside* the section (`find(service)[0] ??
   *  connect()`), so there is no id to key on until the section has already run,
   *  and two overlapping connects must serialize through the SAME chain to
   *  converge on exactly one connection. Different grants of one service — and
   *  different services — hold independent chains and never serialize against
   *  each other.
   *
   *  Composition is deadlock-free by construction: a registry grant mutation
   *  invoked from inside the section (`importCredential`, `revoke`,
   *  `backfillProfile`) acquires only the per-connection grant lock — a
   *  DISTINCT lock this section never holds and which is uncontended while the
   *  section runs — so it runs without re-queueing behind other section work and
   *  cannot deadlock against the section (reentrancy by scope falls out of the
   *  two-layer keying).
   *
   *  A ceremony that rejects neither poisons the next ceremony on the section
   *  nor surfaces as an unhandled rejection (the keyed mutex releases either
   *  way); the original result/rejection is returned to THIS caller unchanged.
   *  Mirrors {@link ConnectionImpl.withGrantLock}. */
  withGrantSection<T>(service: string, grant: GrantName, fn: () => Promise<T>): Promise<T> {
    const key = `${service}\u0000${grant}`;
    return this.sectionMutex.runExclusive(key, fn);
  }

  /** Register an unlock handler. Fires immediately for every already-unlocked
   *  connection, then for every future unlock epoch (connect, load,
   *  importCredential, re-import after degrade, subscription arrival).
   *
   *  Delivery guarantee: only handlers a caller registers SYNCHRONOUSLY inside
   *  the onUnlocked callback (via `conn.talk.onMessage` / `conn.watch.onEvent`)
   *  are guaranteed to see the epoch's FIRST deliveries. For a fresh unlock epoch
   *  the registry fires onUnlocked before the capability's stream starts, so a
   *  synchronous registration is wired before start() runs; a handler attached
   *  later (after an await, or on an already-unlocked connection whose stream is
   *  already running) may miss deliveries the stream emitted synchronously from
   *  start(). Send-before-start is permitted: the wrapper and instance exist when
   *  the callback runs, so `conn.talk.send(...)` inside it works. */
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

  getLedger(): GrantLedger {
    return this.ledger;
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
 * slots (grant epochs), and the AuthState surface. Reads/writes grant state
 * through the ledger; builds/tears down capability instances as grants and
 * subscriptions change.
 */
class ConnectionImpl implements Connection {
  readonly auth: AuthState;

  /** Cached grant state, keyed by grant name; the source of truth is the
   *  ledger, this mirror avoids an async read on every status()/getter call. */
  private readonly grantState = new Map<GrantName, GrantState>();
  /** Live credential per grant name (present ⇔ state !== "unauthorized"). */
  private readonly liveCreds = new Map<GrantName, Credential>();
  /** Grants renewed since their last confer — a second rejection degrades. */
  private readonly renewedSinceLastConfer = new Set<GrantName>();
  /** In-flight renewal promise per grant (single-flight coalescing). */
  private readonly renewalsInFlight = new Map<GrantName, Promise<void>>();
  /** Per-grant serialization: the tail of a promise-chain mutex, keyed by grant
   *  name. Every guardian-facing lifecycle mutation (conferral, revoke, profile
   *  backfill) runs inside its grant's chain, so two overlapping mutations on the
   *  same grant apply in issue order rather than interleaving across their awaited
   *  ledger writes. The mutex lives on the ConnectionImpl and is keyed by grant
   *  name, so different grants — and different connections, which are distinct
   *  ConnectionImpls — serialize independently and never against each other. Keys
   *  are bounded by the descriptor's declared grants and evicted when idle. */
  private readonly grantMutex = new KeyedMutex();

  private readonly slots = new Map<Capability, CapabilitySlot>();
  private watchSubscribed = false;
  private epochCounter = 0;

  constructor(
    readonly id: ConnectionId,
    readonly service: string,
    readonly label: string,
    private readonly descriptor: ConnectionDescriptor,
    private readonly registry: ConnectionRegistry,
  ) {
    for (const cap of ["talk", "act", "watch"] as const) {
      const kind = KIND_OF[cap];
      const capDef = descriptor.capabilities[kind];
      if (!capDef) continue;
      const gated =
        kind === "watcher" && descriptor.capabilities.watcher?.subscriptionGated === true;
      this.slots.set(cap, {
        cap,
        kind,
        needs: capDef.needs,
        subscriptionGated: gated,
        degradation: kind === "talker" ? descriptor.capabilities.talker?.degradation : undefined,
        epoch: null,
        messageHandlers: [],
        eventHandlers: [],
      });
    }
    this.auth = new AuthStateImpl(this);
  }

  private get ledger(): GrantLedger {
    return this.registry.getLedger();
  }
  private get log(): Logger {
    return this.registry.getLogger();
  }

  /** Load grant state from the ledger, rehydrate live credentials (renewing or
   *  degrading expired ones), then build every currently-unlocked capability
   *  and fire onUnlocked. Runs at connect() (all grants "unauthorized") and at
   *  load() (persisted grants). */
  async hydrate(): Promise<void> {
    for (const [name, scheme] of Object.entries(this.descriptor.auth)) {
      const rec = await this.readGrant(name);
      if (!rec || rec.state === "unauthorized") {
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

  /** At-load expired-credential handling: renew once, else degrade. */
  private async renewOrDegradeAtLoad(
    name: GrantName,
    scheme: AuthScheme,
    cred: Credential,
  ): Promise<void> {
    let renewed: Credential | "re-confer";
    try {
      renewed = await scheme.renew(cred);
    } catch (err) {
      // Load runs before any epoch exists — nothing can supersede this flow.
      await this.degradeGrant(name, `renew threw at load: ${errMsg(err)}`, () => true);
      return;
    }
    if (renewed === "re-confer") {
      await this.degradeGrant(name, "renew returned re-confer at load", () => true);
      return;
    }
    // Ledger first (the ledger is authoritative) — consistent with the
    // fault-driven renew path.
    await this.ledger.updateGrant(this.id, name, {
      state: "authorized",
      credential: toPersisted(renewed),
      lastRenewedAt: this.registry.now(),
    });
    this.grantState.set(name, "authorized");
    this.liveCreds.set(name, renewed);
    await this.syncCustody(name, renewed);
  }

  private async readGrant(name: GrantName): Promise<GrantRecord | null> {
    return this.ledger.getGrant(this.id, name);
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

  get talk(): Talk | null {
    const slot = this.slots.get("talk");
    if (!slot || !slot.epoch) return null;
    return this.talkWrapper(slot, slot.epoch);
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

  private talkWrapper(slot: CapabilitySlot, epoch: Epoch): Talk {
    return {
      subscribe: (handler) => {
        this.assertLive(epoch);
        slot.messageHandlers.push(handler);
        return () => {
          const index = slot.messageHandlers.indexOf(handler);
          if (index >= 0) slot.messageHandlers.splice(index, 1);
        };
      },
      send: async (conversationId, msg) => {
        this.assertLive(epoch);
        try {
          return await (epoch.instance as Talker).send(conversationId, msg);
        } catch (err) {
          this.handleThrownFault(slot, err, epoch);
          throw err;
        }
      },
      feature: <K extends TalkFeatureName>(name: K): TalkFeatureMap[K] | null => {
        this.assertLive(epoch);
        const current = (epoch.instance as Talker).feature(name);
        if (!current) return null;
        return this.epochFeatureProxy(slot, epoch, name);
      },
    };
  }

  private epochFeatureProxy<K extends TalkFeatureName>(
    slot: CapabilitySlot,
    epoch: Epoch,
    name: K,
  ): TalkFeatureMap[K] {
    return new Proxy({} as TalkFeatureMap[K] & object, {
      get: (_target, property) => {
        return (...args: unknown[]) => {
          this.assertLive(epoch);
          const feature = (epoch.instance as Talker).feature(name) as
            | (TalkFeatureMap[K] & Record<PropertyKey, unknown>)
            | null;
          if (!feature) throw new Error(`talk feature "${name}" is unavailable`);
          const method = feature[property];
          if (typeof method !== "function") {
            throw new Error(`talk feature "${name}" has no operation "${String(property)}"`);
          }
          try {
            return method.apply(feature, args);
          } catch (err) {
            this.handleThrownFault(slot, err, epoch);
            throw err;
          }
        };
      },
    });
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
   *  into empty handler arrays and drop its first delivery. The wrapper and
   *  instance already exist when onUnlocked fires, so an onUnlocked handler may
   *  call talk.send() before start() has run — send-before-start is permitted. */
  private buildEpoch(slot: CapabilitySlot, fire: boolean): void {
    const creds: Record<GrantName, Credential> = {};
    for (const grant of slot.needs) {
      const cred = this.liveCreds.get(grant);
      if (!cred) {
        this.log.error("buildEpoch missing live credential", {
          connectionId: this.id,
          capability: slot.cap,
          grant,
        });
        return;
      }
      creds[grant] = cred;
    }
    const kit = this.makeKit(slot.needs);
    const capDef = this.descriptor.capabilities[slot.kind];
    if (!capDef) return;
    const instance = capDef.build(creds, kit);
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
    // method doc). A handler may also call talk.send() here — the wrapper and
    // instance exist, so send-before-start works.
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

  /** A kit bound to exactly one capability build()'s needed grants. persist to
   *  any other grant throws — prevents cross-grant writes. */
  private makeKit(needs: readonly GrantName[]): RuntimeKit {
    const allowed = new Set(needs);
    return {
      connectionId: this.id,
      registerIngress: (handler) => this.registry.registerIngress(this.id, handler),
      persist: async (grant: GrantName, material: SecretRecord): Promise<void> => {
        if (!allowed.has(grant)) {
          throw new Error(
            `kit.persist("${grant}") rejected: not in this capability's needs [${[...allowed].join(", ")}]`,
          );
        }
        await this.persistMaterial(grant, material);
      },
    };
  }

  /** Write-through custody: update the grant's stored credential material in
   *  place, and the in-memory Credential so the NEXT build sees it. No epoch
   *  rebuild, no state change, no onUnlocked. Ledger first (the ledger
   *  is authoritative): a failed durable write throws before the in-memory
   *  liveCreds swap, so the mirror keeps the prior material — the next build
   *  cannot see a rotation that never persisted. */
  private async persistMaterial(grant: GrantName, material: SecretRecord): Promise<void> {
    const current = this.liveCreds.get(grant);
    const expiresAt = current?.expiresAt ?? "never";
    const next: Credential = { material, expiresAt };
    await this.ledger.updateGrant(this.id, grant, {
      credential: toPersisted(next),
    });
    this.liveCreds.set(grant, next);
  }

  /** Materialize a grant's custody artifacts (token files, shell auth) from its
   *  live credential material + persisted profile. Fire-and-forget: a failure is
   *  logged and swallowed so it can never fail the transition that triggered it —
   *  the ledger is authoritative and the next transition or boot re-syncs. No-op
   *  for a descriptor with no custody, or an external-custody credential (a
   *  function material has no on-disk secret to mirror). Reads the profile from
   *  the ledger, which was just written in the same transition, so custody always
   *  reflects the current conferral outcome. */
  private async syncCustody(grant: GrantName, cred: Credential): Promise<void> {
    const custody = this.descriptor.custody;
    if (!custody || typeof cred.material === "function") return;
    const material = cred.material;
    try {
      const rec = await this.readGrant(grant);
      await custody.sync(grant, material, rec?.profile ?? {});
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
      await custody.clear(grant);
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
   *  A mutation that legitimately rejects (e.g. a ledger write failure) neither
   *  poisons the next mutation on the grant nor surfaces as an unhandled rejection
   *  (the keyed mutex releases either way); the original result/rejection is still
   *  returned to THIS caller unchanged. */
  private withGrantLock<T>(grant: GrantName, fn: () => Promise<T>): Promise<T> {
    return this.grantMutex.runExclusive(grant, fn);
  }

  grants(): Record<GrantName, GrantState> {
    const out: Record<GrantName, GrantState> = {};
    for (const name of Object.keys(this.descriptor.auth)) {
      out[name] = this.grantState.get(name) ?? "unauthorized";
    }
    return out;
  }

  importCredential(
    grant: GrantName,
    credential: Credential,
    profile?: ProfileRecord,
  ): Promise<void> {
    return this.withGrantLock(grant, () => this.importCredentialLocked(grant, credential, profile));
  }

  private async importCredentialLocked(
    grant: GrantName,
    credential: Credential,
    profile?: ProfileRecord,
  ): Promise<void> {
    const scheme = this.descriptor.auth[grant];
    if (!scheme) throw new Error(`connection "${this.id}" has no grant "${grant}"`);
    // Idempotent: identical inline material over an authorized grant skips the
    // epoch rebuild. A re-conferral can still refresh the profile (renamed login,
    // changed scopes) while reusing the same token, so persist a supplied profile
    // even on the no-op material path — an authorized grant must never keep a
    // previous conferral's profile. No epoch rebuild, no onUnlocked: profile is
    // not credential material.
    if (this.grantState.get(grant) === "authorized") {
      const current = this.liveCreds.get(grant);
      if (
        current &&
        typeof current.material !== "function" &&
        typeof credential.material !== "function" &&
        materialFingerprint(current.material) === materialFingerprint(credential.material)
      ) {
        if (profile !== undefined) {
          await this.ledger.updateGrant(this.id, grant, { profile });
          // The credential is byte-identical, but a re-conferral can still change
          // the profile (renamed login, moved workspace) — re-sync custody so a
          // profile-derived artifact (the Slack file's teamId) stays current.
          await this.syncCustody(grant, current);
        }
        return;
      }
    }
    await this.applyNewCredential(grant, credential, profile);
  }

  /** Fill a MISSING profile on an already-authorized/degraded grant without
   *  touching the credential, grant state, or the capability epoch.
   *  Ledger-only write; then re-sync custody so a profile-derived
   *  artifact reflects the new identity (no-op for a channel — no custody — and
   *  for a degraded grant whose live credential was cleared at load). */
  backfillProfile(grant: GrantName, profile: ProfileRecord): Promise<void> {
    return this.withGrantLock(grant, () => this.backfillProfileLocked(grant, profile));
  }

  private async backfillProfileLocked(grant: GrantName, profile: ProfileRecord): Promise<void> {
    if (!this.descriptor.auth[grant]) {
      throw new Error(`connection "${this.id}" has no grant "${grant}"`);
    }
    await this.ledger.updateGrant(this.id, grant, { profile });
    const cred = this.liveCreds.get(grant);
    if (cred) await this.syncCustody(grant, cred);
  }

  /** Persist a freshly minted/imported credential, mark the grant authorized,
   *  clear the renewed flag, and rebuild every dependent capability. Ledger
   *  first (the ledger is authoritative): if the durable write throws,
   *  the error propagates to the caller with the in-memory mirror untouched —
   *  the grant stays in its prior state, no rebuild. */
  private async applyNewCredential(
    grant: GrantName,
    cred: Credential,
    profile?: ProfileRecord,
  ): Promise<void> {
    await this.ledger.updateGrant(
      this.id,
      grant,
      conferralPatch(this.registry.now(), cred, profile),
    );
    await this.activateGrantInMemory(grant, cred);
  }

  /** Bring a grant live in memory after its authorized credential has been
   *  DURABLY persisted (by `applyNewCredential` above, or by the registry's
   *  transactional `confer` which persists the row inside its own transaction and
   *  then calls this on the already-committed grant). Mirror → reconcile (build
   *  the epoch / start the adapter) → custody. Under the per-grant lock so it
   *  serializes against a concurrent renew/fault on the same grant. */
  activatePersistedGrant(grant: GrantName, cred: Credential): Promise<void> {
    return this.withGrantLock(grant, () => this.activateGrantInMemory(grant, cred));
  }

  private async activateGrantInMemory(grant: GrantName, cred: Credential): Promise<void> {
    this.grantState.set(grant, "authorized");
    this.liveCreds.set(grant, cred);
    this.renewedSinceLastConfer.delete(grant);
    this.reconcile(grant);
    await this.syncCustody(grant, cred);
  }

  revoke(grant: GrantName): Promise<void> {
    return this.withGrantLock(grant, () => this.revokeLocked(grant));
  }

  private async revokeLocked(grant: GrantName): Promise<void> {
    const scheme = this.descriptor.auth[grant];
    if (!scheme) throw new Error(`connection "${this.id}" has no grant "${grant}"`);
    // Ledger first (the ledger is authoritative): a failed durable
    // write propagates to the caller with nothing revoked in memory — the grant
    // stays authorized and its epoch alive.
    await this.ledger.updateGrant(this.id, grant, {
      state: "unauthorized",
      credential: undefined,
      // An unauthorized grant records no conferral outcome — clear the profile
      // with the credential so a revoked grant carries no stale identity.
      // `conferredAt` is deliberately NOT cleared: an unauthorized grant with a
      // conferral on record is the explicit-revoke marker (isExplicitlyRevoked)
      // the boot settings bridge reads to refuse resurrecting a disconnected
      // credential from a retained legacy settings row.
      profile: undefined,
      degraded: undefined,
    });
    this.grantState.set(grant, "unauthorized");
    this.liveCreds.delete(grant);
    this.renewedSinceLastConfer.delete(grant);
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

  /** Faults thrown synchronously from act.invoke / talk.send. The wrapper
   *  rethrows the original error to the caller; the grant flow runs async. */
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
   *  transient ledger write failure inside renew/degrade). Without this a
   *  rejected ledger write would surface as an unhandled promise rejection and,
   *  under Node's default --unhandled-rejections=throw, crash the host. A ledger
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
    // pre-callback window. This flow then awaits (renewalsInFlight join, ledger
    // writes, scheme.renew), and a conferral can complete in ANY of those gaps —
    // tearing down `source` and building a fresh epoch on a fresh credential.
    // Acting after that would clobber the fresh grant (persist `degraded` over a
    // just-authorized conferral), so every state application downstream re-checks
    // this predicate immediately before writing.
    const stillCurrent = () => !source.dead && slot.epoch === source;
    const targets =
      err.grant !== undefined
        ? [err.grant]
        : slot.needs.length === 1
          ? [slot.needs[0]]
          : [...slot.needs];
    for (const grant of targets) {
      await this.renewOnceOrDegrade(grant, err, stillCurrent);
    }
  }

  /** Single-flight renew-once-then-degrade for one grant. `stillCurrent` reports
   *  whether the faulting epoch is still the slot's live epoch; the flow aborts
   *  (no-op) the moment it turns false — a superseded fault must never mutate
   *  the fresh conferral's grant state. */
  private renewOnceOrDegrade(
    grant: GrantName,
    cause: CredentialRejected,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const existing = this.renewalsInFlight.get(grant);
    if (existing) return existing;
    const scheme = this.descriptor.auth[grant];
    if (!scheme) return Promise.resolve();
    const promise = (async () => {
      if (!stillCurrent()) return;
      // Already renewed since last confer → degrade instead of renewing again.
      if (this.renewedSinceLastConfer.has(grant)) {
        await this.degradeGrant(grant, `credential rejected again: ${cause.message}`, stillCurrent);
        return;
      }
      const cred = this.liveCreds.get(grant);
      if (!cred) {
        await this.degradeGrant(grant, "credential rejected with no live credential", stillCurrent);
        return;
      }
      this.renewedSinceLastConfer.add(grant);
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

  /** Attempt a renewal; on success persist + rebuild, on "re-confer"/throw degrade.
   *
   *  Ledger first on the success branch (the ledger is authoritative).
   *  If the durable write throws, the renewal is NOT applied: the mirror is
   *  untouched, so the grant stays authorized with its PRIOR (still-live)
   *  credential and its epoch alive — a failed renew write cannot half-apply a
   *  new credential. The throw propagates up through renewOnceOrDegrade into the
   *  fault flow, where runFaultFlow's .catch swallows it (a ledger blip must not
   *  crash the process). Note `renewOnceOrDegrade` sets `renewedSinceLastConfer`
   *  BEFORE calling us, and we deliberately leave it set on a failed write: the
   *  renew was genuinely attempted, so the next CredentialRejected degrades
   *  rather than looping renew attempts against a flaky ledger. */
  private async renewGrant(
    grant: GrantName,
    scheme: AuthScheme,
    cred: Credential,
    reason: string,
    stillCurrent: () => boolean,
  ): Promise<void> {
    let renewed: Credential | "re-confer";
    try {
      renewed = await scheme.renew(cred);
    } catch (err) {
      await this.degradeGrant(grant, `renew threw (${reason}): ${errMsg(err)}`, stillCurrent);
      return;
    }
    // scheme.renew is the flow's longest await — a conferral completing during
    // it superseded this fault, so neither degrade NOR the renewed credential
    // may be applied over the fresh grant (see handleCredentialRejected).
    if (!stillCurrent()) return;
    if (renewed === "re-confer") {
      await this.degradeGrant(grant, `renew returned re-confer (${reason})`, stillCurrent);
      return;
    }
    await this.ledger.updateGrant(this.id, grant, {
      state: "authorized",
      credential: toPersisted(renewed),
      lastRenewedAt: this.registry.now(),
    });
    // The write itself awaited — same supersession window as degradeGrant's:
    // applying the stale renewal in memory would replace the winner's fresh
    // credential and rebuild over its epoch. Repair the row instead.
    if (!stillCurrent()) {
      await this.repairLedgerFromMirror(grant);
      return;
    }
    this.grantState.set(grant, "authorized");
    this.liveCreds.set(grant, renewed);
    this.reconcile(grant);
    await this.syncCustody(grant, renewed);
  }

  /** Degrade a grant: persist state + reason, relock dependent capabilities.
   *  Sibling grants of those capabilities stay live; onUnlocked fires only on a
   *  future re-import. The ledger credential row is RETAINED (only the
   *  in-memory live credential is dropped, so nothing can use it): the ledger
   *  invariant is `credential present ⇔ state !== "unauthorized"`, and
   *  "degraded" is not "unauthorized". The stale material is inert until a
   *  re-confer replaces it.
   *
   *  Ledger first (the ledger is authoritative). A failed degrade write
   *  throws BEFORE any in-memory change: the grant stays "authorized" in memory
   *  with its live credential and epoch intact — a DB blip must not half-degrade.
   *  The throw propagates up the fault flow, where runFaultFlow's .catch swallows
   *  it (never crashes the process); the next CredentialRejected retriggers the
   *  renew-once-then-degrade flow and, with the ledger healthy, degrades cleanly.
   *
   *  `stillCurrent` is the fault flow's superseded-epoch predicate, re-checked on
   *  BOTH sides of the awaited ledger write: a conferral/revoke completing during
   *  the write owns the grant, so this flow must neither apply the degraded state
   *  in memory (which would tear down the winner's fresh epoch) nor leave its
   *  stale row behind (repaired from the mirror). Load-time callers, which run
   *  before any epoch exists, pass `() => true`. */
  private async degradeGrant(
    grant: GrantName,
    reason: string,
    stillCurrent: () => boolean,
  ): Promise<void> {
    if (!stillCurrent()) return;
    await this.ledger.updateGrant(this.id, grant, {
      state: "degraded",
      degraded: { at: this.registry.now(), reason },
    });
    if (!stillCurrent()) {
      await this.repairLedgerFromMirror(grant);
      return;
    }
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

  /** Re-assert the in-memory mirror onto the ledger after a superseded fault
   *  flow's write may have landed ON TOP of the superseding conferral/revoke
   *  write (the two writes race only across the awaited ledger call; whichever
   *  lands last wins the row). The mirror is authoritative here: the winner
   *  finished its own ledger-first sequence before the supersession became
   *  observable, so rewriting the row from the mirror restores exactly the
   *  winner's outcome. A "degraded" mirror means another fault flow legitimately
   *  owns the row — leave it. */
  private async repairLedgerFromMirror(grant: GrantName): Promise<void> {
    const state = this.grantState.get(grant) ?? "unauthorized";
    const cred = this.liveCreds.get(grant);
    if (state === "authorized" && cred) {
      await this.ledger.updateGrant(this.id, grant, {
        state: "authorized",
        credential: toPersisted(cred),
        degraded: undefined,
      });
    } else if (state === "unauthorized") {
      await this.ledger.updateGrant(this.id, grant, {
        state: "unauthorized",
        credential: undefined,
        profile: undefined,
        degraded: undefined,
      });
    }
    this.log.warn("superseded fault flow repaired ledger from mirror", {
      connectionId: this.id,
      grant,
      state,
    });
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
      const kit = this.makeKit(slot.needs);
      // Read the CURRENT live credentials, not the frozen epoch.creds: kit.persist
      // replaces the liveCreds entry in place (no epoch rebuild), so a backoff
      // rebuild must pick up the post-persist material — otherwise write-through
      // custody (Baileys key rotation) is defeated on the next reconnect.
      const creds: Record<GrantName, Credential> = {};
      for (const grant of slot.needs) {
        const cred = this.liveCreds.get(grant);
        if (!cred) {
          // A needed grant went away under us (relock raced the wait) — abandon
          // this rebuild; the relock already tore the epoch down.
          this.log.warn("Disconnected rebuild missing live credential; abandoning", {
            connectionId: this.id,
            capability: slot.cap,
            grant,
          });
          return;
        }
        creds[grant] = cred;
      }
      const instance = capDef.build(creds, kit);
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
