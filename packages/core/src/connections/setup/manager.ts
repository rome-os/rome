// In-memory connection setup sessions keyed by addressed grant.
//
// One active setup per addressed grant. The key is the connection id the setup
// route resolved (real connection) or the bare connection kind (offerable
// placeholder that has no row yet), joined with the grant. A duplicate start on
// a live setup re-attaches to it; `force` cancels-and-replaces (explicit cancel
// then start begins fresh). Sessions do NOT survive a process restart
// (resurrection is deferred — `ctx.step` keeps the door open). A finished setup
// stays reachable by `cid` for a final poll, but no longer counts as the grant's
// active setup, so the next start begins fresh.
//
// The manager owns the terminal write: when a coroutine returns its conferral,
// the manager hands it to `registry.confer` inside the registry's per-(connection kind,
// grant) critical section. `confer` resolves the ADDRESSED connection (never
// blindly `find()[0]`, which could clobber a different connection of the same
// connection kind), mints the placeholder for the offerable flow, persists the
// credential + profile, and runs the guardian channel mapping — ALL in one DB
// transaction. A mapping failure rolls the credential and the mint back with it,
// so a failed conferral leaves zero residual state instead of a credential
// authorized while the setup reports `failed`.

import { randomUUID } from "node:crypto";
import type { DrizzleTx } from "../../db/index.js";
import { KeyedMutex } from "../../lib/keyed-mutex.js";
import type { PersonMappingRepository } from "../../db/repositories/person-mapping.js";
import {
  applyGuardianMappingWithinTx,
  planGuardianMapping,
} from "../../channels/guardian-mapping.js";
import type { ConferOptions } from "../registry.js";
import type { Connection, ConnectionDescriptor, Credential, ProfileRecord } from "../types.js";
import { SetupAbortError, SetupSession, type SetupInputOutcome } from "./session.js";
import type { SetupConferral, SetupState } from "./types.js";

/** The narrow registry surface the manager drives — every real
 *  `ConnectionRegistry` satisfies it structurally, and tests fake it directly. */
export interface SetupRegistry {
  getDescriptor(connectionKind: string): ConnectionDescriptor | null;
  withGrantSection<T>(connectionKind: string, grant: string, fn: () => Promise<T>): Promise<T>;
  /** The atomic terminal conferral: resolve/mint the addressed connection,
   *  persist the credential + profile, and run `opts.inTx` (the guardian mapping)
   *  in ONE transaction, then start the adapter. See `ConnectionRegistry.confer`. */
  confer(
    connectionKind: string,
    connectionId: string | undefined,
    grant: string,
    credential: Credential,
    profile: ProfileRecord | undefined,
    opts?: ConferOptions,
  ): Promise<Connection>;
}

export interface SetupManagerDeps {
  registry: SetupRegistry;
  personMappingRepo: PersonMappingRepository;
}

/** What a setup addresses: the connection kind, plus the connection id when the route
 *  targeted an existing connection (absent for an offerable placeholder — the
 *  terminal conferral mints the row). `another` asks for a new account of the
 *  connection kind, minted by the terminal conferral like a placeholder's, so an
 *  abandoned setup leaves no account behind. */
export interface SetupTarget {
  connectionKind: string;
  connectionId?: string;
  another?: boolean;
}

/** Raised when a start targets a grant whose descriptor declares no setup. */
export class NoSetupError extends Error {
  constructor(
    readonly connectionKind: string,
    readonly grant: string,
  ) {
    super(`No conferral setup for grant "${grant}" of connection kind "${connectionKind}".`);
    this.name = "NoSetupError";
  }
}

/** The result of starting (or re-attaching to) a setup. */
export interface SetupStart {
  cid: string;
  state: SetupState;
  /** True when this start re-attached to a setup already in progress. */
  reattached: boolean;
}

interface Managed {
  cid: string;
  target: SetupTarget;
  grant: string;
  session: SetupSession;
  /** A redirect state this setup owned, kept past the moment the session stops
   *  advertising it — cancellation erases the URL, and an accepted leg moves the
   *  session off `awaiting-redirect`. Either way the correlation is the only
   *  route back to THIS setup, and without it a repeat delivery reads as a flow
   *  that never started a setup: the caller then falls through to the sign-in
   *  redeem, which shares the OAuth primitive and would race the redemption
   *  already in flight. */
  ownedRedirectState?: string;
}

/** The active-setup key: the addressed connection id, or the connection kind for a
 *  placeholder, joined with the grant. */
function keyOf(idOrKind: string, grant: string): string {
  return `${idOrKind}\u0000${grant}`;
}

/** What a new account of `connectionKind` is keyed by in place of a connection id. A
 *  connection kind never holds the separator, so it names no connection or
 *  placeholder. */
export function anotherAccountKey(connectionKind: string): string {
  return `${connectionKind}\u0001another`;
}

function keyOfTarget(target: SetupTarget, grant: string): string {
  const address =
    target.connectionId ??
    (target.another ? anotherAccountKey(target.connectionKind) : target.connectionKind);
  return keyOf(address, grant);
}

/** The `state` query param carried by a redirect URL — the return-leg
 *  correlation token. Null for a URL that carries none or does not parse (a
 *  redirect with no return correlation is not resumable by state). */
function redirectStateOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("state");
  } catch {
    return null;
  }
}

export class SetupManager {
  readonly #deps: SetupManagerDeps;
  readonly #byKey = new Map<string, Managed>();
  readonly #byCid = new Map<string, Managed>();
  /** Per-key serialization for start(): the whole lookup/cancel/create sequence
   *  runs to completion before the next start on the same key begins, so two
   *  concurrent `force` starts cannot both cancel the same session and then each
   *  install a fresh one (which would leave two conferrable sessions live).
   *  Keyed by `${idOrKind} ${grant}`; entries evict when idle. */
  readonly #startMutex = new KeyedMutex();

  constructor(deps: SetupManagerDeps) {
    this.#deps = deps;
  }

  /** Start a setup for the addressed `(target, grant)`, or re-attach to the one
   *  already running there. `force` cancels a live setup and starts a fresh one.
   *  Serialized per key so the one-active-setup invariant holds under concurrent
   *  starts. */
  start(target: SetupTarget, grant: string, opts: { force?: boolean } = {}): Promise<SetupStart> {
    const key = keyOfTarget(target, grant);
    return this.#startMutex.runExclusive(key, () => this.#startLocked(key, target, grant, opts));
  }

  async #startLocked(
    key: string,
    target: SetupTarget,
    grant: string,
    opts: { force?: boolean },
  ): Promise<SetupStart> {
    const existing = this.#byKey.get(key);
    if (existing && !existing.session.isTerminal) {
      if (opts.force) {
        await this.#cancelManaged(existing);
        // Leave it reachable by cid for a final poll; it is no longer active.
      } else {
        return { cid: existing.cid, state: existing.session.state, reattached: true };
      }
    }

    const fn = this.#deps.registry.getDescriptor(target.connectionKind)?.auth[grant]?.setup;
    if (!fn) throw new NoSetupError(target.connectionKind, grant);

    const cid = randomUUID();
    const session = new SetupSession({
      fn,
      commit: (conferral, signal) => this.#commit(target, grant, conferral, signal),
      renewing: target.connectionId !== undefined,
    });
    const managed: Managed = { cid, target, grant, session };
    this.#byKey.set(key, managed);
    this.#byCid.set(cid, managed);
    await session.started();
    return { cid, state: session.state, reattached: false };
  }

  /** The current state of a setup by id, or null when unknown. */
  state(cid: string): SetupState | null {
    return this.#byCid.get(cid)?.session.state ?? null;
  }

  /** The id of the live setup addressed by `idOrKind` (a connection id, or a
   *  connection kind for a placeholder) and `grant`, or null when none is active. */
  activeFor(idOrKind: string, grant: string): string | null {
    const managed = this.#byKey.get(keyOf(idOrKind, grant));
    return managed && !managed.session.isTerminal ? managed.cid : null;
  }

  /** Cancel the live setup addressed by `(idOrKind, grant)`, if any, and wait
   *  for it to unwind. Teardown uses this so a revoke cannot be silently undone
   *  by an in-flight setup's terminal write. No-op when nothing is active. */
  async cancelActive(idOrKind: string, grant: string): Promise<void> {
    const cid = this.activeFor(idOrKind, grant);
    if (cid) await this.cancel(cid);
  }

  /** Feed the guardian's answers to a setup awaiting input. */
  provideInput(cid: string, answers: Record<string, string>): Promise<SetupInputOutcome> | null {
    const session = this.#byCid.get(cid)?.session;
    return session ? session.provideInput(answers) : null;
  }

  /** Feed a redirect return-leg payload to a setup awaiting a redirect. */
  provideReturn(cid: string, payload: Record<string, string>): Promise<SetupInputOutcome> | null {
    const session = this.#byCid.get(cid)?.session;
    return session ? session.provideReturn(payload) : null;
  }

  /**
   * Feed a redirect return-leg to whichever setup is suspended at a `redirect`
   * whose URL carries this `state` — the OAuth out-and-back correlation. The
   * browser fully navigates away to the broker and back, so the return leg
   * cannot carry the `cid`; it correlates by the `state` query param the
   * broker echoes.
   *
   * The lookup is a scan (active setups are few; `state` values are 24-byte
   * opaque codes, so a match is unambiguous). Because it resolves ONLY a session
   * still parked at `awaiting-redirect`, the idempotency guarantees fall out for
   * free: once a return leg has resumed a coroutine it is no longer awaiting a
   * redirect, so a double/late delivery finds no live match, and a delivery to a
   * session that already advanced is rejected by the session's own pending-kind
   * guard.
   *
   * A setup keeps its state after that, so the repeat still matches — with
   * `accepted:false` and the setup's current state. Not keeping it would report
   * "no setup owns this", and the callback page treats that as sign-in and
   * redeems the handoff itself. That page now stays put in the system browser,
   * so a plain reload is enough to hit it: mid-redemption the two paths race,
   * and the guardian can be shown a failure while the credential lands.
   *
   * Returns `{ cid, connectionKind, outcome }` for the setup that owns the state (live,
   * finished, or cancelled), or `null` when none does (unknown/expired, or a
   * flow that never started a setup). `connectionKind` names the connection the leg
   * belongs to, so the browser can return to that connection's own page rather
   * than a fixed destination.
   */
  provideReturnByState(
    state: string,
    payload: Record<string, string>,
  ): { cid: string; connectionKind: string; outcome: Promise<SetupInputOutcome> } | null {
    let owner: Managed | null = null;
    for (const managed of this.#byCid.values()) {
      const current = managed.session.state;
      if (current.status === "awaiting-redirect" && redirectStateOf(current.url) === state) {
        // Claim the correlation before resuming: the session is about to leave
        // `awaiting-redirect`, and from then on this retained value is the only
        // thing that can still identify the leg as belonging here.
        managed.ownedRedirectState = state;
        return {
          cid: managed.cid,
          connectionKind: managed.target.connectionKind,
          outcome: managed.session.provideReturn(payload),
        };
      }
      if (managed.ownedRedirectState === state) owner = managed;
    }
    if (owner) {
      const current = owner.session.state;
      return {
        cid: owner.cid,
        connectionKind: owner.target.connectionKind,
        outcome: Promise.resolve({
          accepted: false,
          reason:
            current.status === "cancelled"
              ? "Setup was cancelled."
              : "This return leg was already delivered.",
          state: current,
        }),
      };
    }
    return null;
  }

  /** Cancel a setup by id. Returns its terminal state, or null when unknown. */
  cancel(cid: string): Promise<SetupState> | null {
    const managed = this.#byCid.get(cid);
    return managed ? this.#cancelManaged(managed) : null;
  }

  /** Preserve ownership of a parked redirect before cancellation erases the URL
   *  from the session's public state. Deliberately in-memory, matching the
   *  lifetime of setup sessions themselves. */
  #cancelManaged(managed: Managed): Promise<SetupState> {
    const current = managed.session.state;
    if (current.status === "awaiting-redirect") {
      const state = redirectStateOf(current.url);
      if (state) managed.ownedRedirectState = state;
    }
    return managed.session.cancel();
  }

  /** The terminal write: hand the conferral to `registry.confer`, which mints
   *  the addressed placeholder if needed, persists the credential + profile, and
   *  runs the guardian mapping — ALL in one transaction, so a mapping failure
   *  rolls the credential (and the mint) back with it rather than leaving a
   *  credential authorized while the setup reports `failed`. Wrapped in the
   *  per-(connection kind, grant) critical section so a competing setup or teardown
   *  cannot interleave; the guardian mapping is decided from async reads BEFORE
   *  the transaction, then applied as a synchronous participant inside it. */
  async #commit(
    target: SetupTarget,
    grant: string,
    conferral: SetupConferral,
    signal: AbortSignal,
  ): Promise<string> {
    return this.#deps.registry.withGrantSection(target.connectionKind, grant, async () => {
      // A cancel that landed while the write waited for the section wins, so
      // an abandoned setup leaves nothing behind.
      if (signal.aborted) throw new SetupAbortError();
      const channelUserId = conferral.guardianChannelUserId;
      const plan = channelUserId
        ? await planGuardianMapping(
            this.#deps.personMappingRepo,
            target.connectionKind,
            channelUserId,
          )
        : null;
      const opts = {
        ...(plan && channelUserId
          ? {
              inTx: (tx: DrizzleTx) =>
                applyGuardianMappingWithinTx(
                  tx,
                  this.#deps.personMappingRepo,
                  target.connectionKind,
                  channelUserId,
                  plan,
                ),
            }
          : {}),
        ...(target.another ? { another: true } : {}),
      };
      const connection = await this.#deps.registry.confer(
        target.connectionKind,
        target.connectionId,
        grant,
        conferral.credential,
        conferral.profile,
        Object.keys(opts).length > 0 ? opts : undefined,
      );
      return connection.id;
    });
  }
}
