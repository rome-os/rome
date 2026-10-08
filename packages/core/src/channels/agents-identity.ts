/**
 * Keeps the Agents channel's links on the endpoint they were made for. An
 * agent's account id is its address, because that is what Rome Cloud sends to,
 * but an address is not stable: a linked account's owner can change its
 * handle, and a removed endpoint's name can return under a new endpoint. Cloud
 * also names each endpoint by an `endpointId` that never changes, so Rome
 * records which endpoint holds each address and settles every change it sees,
 * from an inbound message or from Cloud's listing.
 *
 * An endpoint that leaves an address takes its link (or dismissal) off it,
 * whether it was renamed or another endpoint took the address. The link waits
 * on the endpoint's record and goes back to it at its next address, unless:
 * - that address is on the other side of this Rome's own account, so a link
 *   never carries the guardian's trust to another account's agent or back, or
 * - someone has already decided about that address, and the decision stands.
 *
 * Each settlement writes the record and the links in one transaction, so it
 * lands whole or not at all.
 *
 * Cloud's listing is its current state and always settles, unless a listing
 * asked for later has already settled, or a message moved the endpoint after
 * it was asked for. A message is as old
 * as when it was sent, and settles an endpoint only against what earlier
 * messages said of it, never against a listing, so a message Cloud held while
 * Rome was offline cannot undo a rename the listing already settled. A message
 * that disagrees with a listing has Cloud listed again before it is read, so a
 * rename still reaches the person on its first message. The same disagreement
 * is listed again at most once a half minute, so a run of held-back messages
 * reads Cloud once. A message waits for that read only briefly, outside the
 * settlement queue, and not at all for a while after a read fails or hangs.
 * An endpoint the listing has left out is not listed again for, and is moved
 * by its own messages sent after the last Rome saw of it. When no listing
 * answers in time, a link stops answering
 * for an address a listing gave another endpoint, so a reused name never
 * speaks as the old endpoint's person; the next listing gives the link back
 * if it still holds. A listing that leaves an endpoint out stops vouching for
 * its address. Rome's clock stands in for Cloud's only to order an unlisted
 * endpoint's messages against the listing that last named it.
 *
 * Conversation history stays under the address it was written to. An endpoint
 * first seen here takes over whatever its address already holds, such as a
 * link the guardian made on the People page before any message came.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
import type { DrizzleDb } from "../db/index.js";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import {
  type AgentEndpointSummary,
  type AgentMessageEnvelope,
  type AgentMessagingClient,
  agentAddress,
  agentAddressAccount,
} from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";

const log = createLogger("agents-identity");

/** How long a listing read for one disagreement answers it again, matching
 *  how long the People page keeps one read. */
const RELIST_MS = 30_000;

/** How long a message waits for each listing read: the first since boot, and
 *  one for its disagreement. Both together stay well inside the admission
 *  limit, which the message would otherwise miss. */
const RELIST_WAIT_MS = 3_000;

/** The settings key holding what Rome last knew of each endpoint. */
export const AGENTS_ENDPOINTS_KEY = "agentsEndpoints";

/** What Rome last knew of an endpoint. */
interface Known {
  /** The address it holds, or null after it left one and none is known yet. */
  address: string | null;
  /** Where that came from, and when the newest message from it Rome has
   *  read was sent, by Cloud's clock. */
  by: "listing" | "message";
  at?: number;
  /** When the newest listing that named it was asked for, by Rome's clock. */
  listedAt?: number;
  /** The person whose link it took off `parkedFrom`, waiting to go back. */
  parked?: string;
  parkedFrom?: string;
  /** The name the link carried there. */
  parkedName?: string;
  /** When it was taken off, by Rome's clock. */
  parkedAt?: number;
  /** Set when a listing put it at its address and a later one left it out,
   *  so the listing no longer vouches for that address against another
   *  endpoint. Its messages are then ordered by when they were sent, so it is
   *  followed through a rename the listing can no longer say. */
  unlisted?: true;
}

/** One endpoint as Cloud names it. A message's sighting carries when it was
 *  sent; a listing's is current. */
export type AgentSighting =
  | { endpointId: string; address: string; by: "listing" }
  | { endpointId: string; address: string; by: "message"; at: number };

/** The endpoint an inbound message names, when Cloud gives its id. */
export function agentSightings(message: ChannelMessage): AgentSighting[] {
  const envelope = message.raw as Partial<AgentMessageEnvelope> | undefined;
  const endpointId = envelope?.from?.endpointId;
  const at = Date.parse(envelope?.sentAt ?? "");
  return endpointId && !Number.isNaN(at)
    ? [{ endpointId, address: message.senderId, by: "message", at }]
    : [];
}

/** The endpoints a listing names, or null from a Cloud that predates
 *  endpoint ids, whose listing cannot say which endpoint holds an address. */
export function listingSightings(
  endpoints: readonly AgentEndpointSummary[],
): AgentSighting[] | null {
  if (endpoints.some((endpoint) => !endpoint.endpointId)) return null;
  return endpoints.flatMap((endpoint) => {
    const address = agentAddress(endpoint);
    return address !== null
      ? [{ endpointId: endpoint.endpointId, address, by: "listing" as const }]
      : [];
  });
}

/** Reads Cloud's listing now, or null when Cloud cannot be read. */
export async function listAgentSightings(
  client: Pick<AgentMessagingClient, "endpoints">,
): Promise<AgentSighting[] | null> {
  try {
    return listingSightings((await client.endpoints()).endpoints);
  } catch (err) {
    log.warn("Could not list agent endpoints to settle a message", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface AgentsIdentity {
  /** Settles what the sightings change. Never throws. */
  observe(sightings: readonly AgentSighting[]): Promise<void>;
  /** Settles a listing asked for at `askedAt`, unless one asked for later has
   *  settled first. Never throws. */
  observeListing(sightings: readonly AgentSighting[], askedAt: number): Promise<void>;
  /** Reads and settles Cloud's listing, once since boot. The first message
   *  does it too, if this has not. Never throws. */
  prime(): Promise<void>;
  /** Runs `fn` after every earlier settlement, and before any later one. The
   *  guardian link runs here, so no settlement moves a link onto the address
   *  between its check that nobody holds it and its link. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
}

const isOwn = (address: string) => agentAddressAccount(address) === null;

/** Whether a message's sighting is older than what Rome knows of `entry`.
 *  Only for the endpoint's own record is a message ordered against a listing,
 *  with Rome's clock standing in for Cloud's: a skew there delays a rename
 *  by a message, but never lets another endpoint's link answer for it. */
function staleAgainst(sighting: AgentSighting, entry: Known | undefined, own: boolean): boolean {
  if (sighting.by === "listing" || !entry) return false;
  if (entry.by === "listing" && !entry.unlisted) return entry.address !== sighting.address;
  return (entry.at ?? 0) > sighting.at || (own && (entry.listedAt ?? 0) > sighting.at);
}

/** Whether a message disagrees with what a listing recorded, which only a
 *  fresh listing can settle. */
function disputes(sighting: AgentSighting, entry: Known | undefined): boolean {
  // A listing that leaves the endpoint out cannot settle where it went.
  return (
    sighting.by === "message" &&
    entry?.by === "listing" &&
    !entry.unlisted &&
    entry.address !== sighting.address
  );
}

/** Names one disagreement, so the same one is listed again only so often. */
const disputeKey = (sighting: AgentSighting) => `${sighting.endpointId} ${sighting.address}`;

/** The part of an endpoint's record a sighting sets. */
function seenBy(
  sighting: AgentSighting,
  entry: Known | undefined,
  askedAt: number,
): Pick<Known, "by" | "at" | "listedAt" | "unlisted"> {
  return sighting.by === "message"
    ? { by: "message", at: Math.max(entry?.at ?? 0, sighting.at) }
    : { by: "listing", listedAt: Math.max(entry?.listedAt ?? 0, askedAt), unlisted: undefined };
}

/** A message's disagreement with a listing, and whether it is about another
 *  endpoint holding the address, which a link must not go on vouching for. */
interface Dispute {
  key: string;
  sighting: AgentSighting;
  held: boolean;
}

export function createAgentsIdentity(deps: {
  db: Pick<DrizzleDb, "transaction">;
  personMappingRepo: Pick<
    PersonMappingRepository,
    "readChannelHolder" | "readPersonCreatedAt" | "writeChannelMapping" | "writeUnlinkAccount"
  >;
  settingsRepo: Pick<SettingsRepository, "read" | "write">;
  channel: string;
  /** Reads Cloud's listing now, for a message that disagrees with an earlier
   *  one. Null when Cloud cannot be read. */
  list?: () => Promise<AgentSighting[] | null>;
  now?: () => number;
  /** How long a message waits for that listing. */
  relistWaitMs?: number;
}): AgentsIdentity {
  const now = deps.now ?? Date.now;
  const repo = deps.personMappingRepo;
  const settings = deps.settingsRepo;
  const channel = deps.channel;
  let queue: Promise<unknown> = Promise.resolve();
  /** When the newest listing settled so far was asked for. */
  let listedAt = Number.NEGATIVE_INFINITY;
  /** When each disagreement last had a listing answer it. */
  const relisted = new Map<string, number>();
  /** The listing being read for each disagreement now, which says whether it
   *  came back. */
  const reading = new Map<string, Promise<boolean>>();
  /** The first listing read since boot, before which Rome may not know an
   *  endpoint's earlier address. */
  let priming: Promise<void> | null = null;
  /** Until when a listing that failed or hung is not read or waited for
   *  again, so a Cloud outage does not slow every message. */
  let quietUntil = Number.NEGATIVE_INFINITY;
  /** When a message last moved each endpoint, so a listing asked for before
   *  then does not move it back. */
  const messaged = new Map<string, number>();
  const movedSince = (id: string, askedAt: number) =>
    (messaged.get(id) ?? Number.NEGATIVE_INFINITY) > askedAt;

  const unreachable = () => {
    quietUntil = now() + RELIST_MS;
  };
  const quiet = () => now() < quietUntil;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Settles the sightings, and returns the disagreements between a message
   *  and a listing. A listing names every endpoint Cloud has. Withholding
   *  takes the link off an address a listing gave another endpoint, for a
   *  message no listing could answer. */
  function settle(
    sightings: readonly AgentSighting[],
    how: { listing?: { askedAt: number }; withhold?: boolean } = {},
  ): Dispute[] {
    // Noted only once the transaction lands, so a rollback moves nothing.
    const moved: string[] = [];
    const disputed = deps.db.transaction((tx) => {
      const disputed: Dispute[] = [];
      const known = settings.read<Record<string, Known>>(tx, AGENTS_ENDPOINTS_KEY) ?? {};
      const before = JSON.stringify(known);
      const holders = new Map<string, string>();
      for (const [id, entry] of Object.entries(known)) {
        if (entry.address !== null) holders.set(entry.address, id);
      }
      const holderOf = (address: string) => repo.readChannelHolder(tx, channel, address);

      /** Takes an endpoint's link off the address it is leaving, keeping it on
       *  the endpoint's record. */
      function leave(id: string, from: string): void {
        const holder = holderOf(from);
        const person = holder?.personId;
        known[id] = {
          ...known[id],
          address: null,
          ...(person
            ? {
                parked: person,
                parkedFrom: from,
                parkedAt: now(),
                ...(holder?.displayName ? { parkedName: holder.displayName } : {}),
              }
            : {}),
        };
        holders.delete(from);
        if (person) {
          repo.writeUnlinkAccount(tx, person, channel, from);
          log.info("an agent left its address; its link waits for it", { address: from });
        }
      }

      /** Gives an endpoint's waiting link back at its current address. */
      function restore(id: string): void {
        const entry = known[id];
        if (!entry?.parked || !entry.parkedFrom || entry.address === null) return;
        const { parked, parkedFrom: _from, parkedName, parkedAt, ...rest } = entry;
        const createdAt = repo.readPersonCreatedAt(tx, parked);
        known[id] = rest;
        if (isOwn(entry.parkedFrom) !== isOwn(entry.address)) {
          // It can never go back, so it stops waiting.
          log.warn("an agent moved between accounts; its link stays off", {
            from: entry.parkedFrom,
            to: entry.address,
          });
        } else if (
          !createdAt ||
          createdAt.getTime() >= Math.floor((parkedAt ?? Number.POSITIVE_INFINITY) / 1000) * 1000
        ) {
          // Merged into someone else since, and gone with the merge, even if
          // a new person has taken the id since. A person's creation is kept
          // to the second, so one made in the second it left counts as new.
          log.warn("an agent's waiting link was to a person who is gone; it is dropped", {
            to: entry.address,
          });
        } else if (holderOf(entry.address) === null) {
          // A name built from the old address names the new one now.
          const name =
            parkedName === entry.parkedFrom || parkedName?.startsWith(`${entry.parkedFrom} `)
              ? entry.address + parkedName.slice(entry.parkedFrom.length)
              : parkedName;
          repo.writeChannelMapping(tx, parked, channel, entry.address, name);
          log.info("an agent's link followed it to its new address", { to: entry.address });
        } else {
          log.info("an agent's waiting link is dropped; its new address is already decided", {
            to: entry.address,
          });
        }
      }

      // An endpoint Rome knows goes first, so one renamed within a listing has
      // left its old address before a new endpoint is seen taking it.
      const ordered = [...sightings].sort(
        (a, b) =>
          Number(known[b.endpointId] !== undefined) - Number(known[a.endpointId] !== undefined),
      );
      for (const sighting of ordered) {
        const { endpointId, address } = sighting;
        const entry = known[endpointId];
        if (how.listing && movedSince(endpointId, how.listing.askedAt)) {
          // A message moved it after this listing was asked for.
          continue;
        }
        if (staleAgainst(sighting, entry, true)) {
          if (disputes(sighting, entry)) {
            disputed.push({ key: disputeKey(sighting), sighting, held: false });
          }
          continue;
        }
        const seen = seenBy(sighting, entry, how.listing?.askedAt ?? 0);
        if (entry?.address === address) {
          // A message agreeing with a listing leaves it the listing's, and
          // only notes when it was sent.
          known[endpointId] =
            sighting.by === "listing" || entry.by === "message"
              ? { ...entry, ...seen }
              : { ...entry, at: seen.at };
          restore(endpointId);
          continue;
        }
        const holder = holders.get(address);
        if (holder !== undefined && holder !== endpointId) {
          // A message never takes an address from an endpoint a listing put
          // there; only a fresh listing can say it moved.
          if (
            sighting.by === "message" &&
            known[holder]?.by === "listing" &&
            !known[holder]?.unlisted
          ) {
            if (how.withhold) {
              // The listing that put it there may be out of date, so its link
              // stops answering for the address until a listing says again.
              leave(holder, address);
            } else {
              disputed.push({ key: disputeKey(sighting), sighting, held: true });
            }
            continue;
          }
          if (staleAgainst(sighting, known[holder], false)) continue;
          // Nor does a listing asked for before a message moved the holder.
          if (how.listing && movedSince(holder, how.listing.askedAt)) continue;
          // Cloud gives an address to one endpoint at a time, so the one that
          // held it has left, whether removed or renamed.
          leave(holder, address);
        }

        if (entry?.address && entry.address !== address) {
          leave(endpointId, entry.address);
        }
        known[endpointId] = { ...known[endpointId], address, ...seen };
        if (sighting.by === "message") moved.push(endpointId);
        holders.set(address, endpointId);
        restore(endpointId);
      }

      if (how.listing) {
        // Cloud's listing names every endpoint it still has, so one a listing
        // put at an address and this one leaves out no longer holds it on a
        // listing's word: a message from another endpoint there can take it.
        const listed = new Set(sightings.map((sighting) => sighting.endpointId));
        for (const [id, entry] of Object.entries(known)) {
          if (entry.by === "listing" && entry.address !== null && !listed.has(id)) {
            known[id] = { ...entry, unlisted: true };
          }
        }
      }
      for (const [id, entry] of Object.entries(known)) {
        if (entry.address === null && !entry.parked) delete known[id];
      }
      if (JSON.stringify(known) !== before) settings.write(tx, AGENTS_ENDPOINTS_KEY, known);
      return disputed;
    });
    const at = now();
    for (const id of moved) messaged.set(id, at);
    return disputed;
  }

  /** Settles a listing unless a later-asked one already has. */
  function settleListing(listing: readonly AgentSighting[], askedAt: number): void {
    if (askedAt < listedAt) return;
    settle(listing, { listing: { askedAt } });
    listedAt = askedAt;
    quietUntil = Number.NEGATIVE_INFINITY;
  }

  /** Lists Cloud again for these disagreements and settles what it says.
   *  Says whether a listing came back. */
  async function relistNow(
    list: () => Promise<AgentSighting[] | null>,
    disputed: readonly Dispute[],
    askedAt: number,
  ): Promise<boolean> {
    const listing = await list();
    if (!listing) {
      unreachable();
      return false;
    }
    await serial(async () => settleListing(listing, askedAt));
    for (const { key } of disputed) relisted.set(key, askedAt);
    return true;
  }

  /** Resolves false after the wait a message gives Cloud. */
  function waited<T>(read: Promise<T>): Promise<T | false> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      read,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          unreachable();
          resolve(false);
        }, deps.relistWaitMs ?? RELIST_WAIT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Has a listing answer these disagreements, reading one only where none is
   *  being read, and waiting for it only so long. Unanswered, a link stops
   *  answering for an address a listing gave another endpoint, and the
   *  listing gives it back if it still says so. */
  async function decide(
    list: () => Promise<AgentSighting[] | null>,
    disputed: readonly Dispute[],
    askedAt: number,
  ): Promise<void> {
    const fresh = quiet() ? [] : disputed.filter(({ key }) => !reading.has(key));
    if (fresh.length > 0) {
      const read = relistNow(list, fresh, askedAt).catch((err: unknown) => {
        log.warn("Could not settle a fresh agent listing", {
          error: err instanceof Error ? err.message : String(err),
        });
        unreachable();
        return false;
      });
      for (const { key } of fresh) reading.set(key, read);
      void read.then(() => {
        for (const { key } of fresh) if (reading.get(key) === read) reading.delete(key);
      });
    }
    const reads = [...new Set(disputed.map(({ key }) => reading.get(key)))];
    const answered =
      !quiet() &&
      !reads.includes(undefined) &&
      (await waited(Promise.all(reads).then((all) => all.every(Boolean))));
    const held = disputed.filter((dispute) => dispute.held).map((dispute) => dispute.sighting);
    if (held.length === 0) return;
    await serial(async () => {
      // Read again against whatever listing settled meanwhile, which may
      // have stopped vouching for the address. With none as fresh as this
      // read, the old link stops answering for it.
      settle(held, { withhold: !answered && listedAt < askedAt });
    });
  }

  /** Reads Cloud's listing once after boot, so an endpoint renamed before Rome
   *  first saw it is still found at its earlier address. A read that fails
   *  is tried again by the next message. */
  function prime(list: () => Promise<AgentSighting[] | null>): Promise<void> {
    priming ??= (async () => {
      const askedAt = now();
      const listing = await list().catch(() => null);
      if (!listing) {
        unreachable();
        throw new Error("Cloud's listing could not be read");
      }
      await serial(async () => settleListing(listing, askedAt));
    })().catch((err: unknown) => {
      priming = null;
      throw err;
    });
    return priming;
  }

  function guarded(run: Promise<void>): Promise<void> {
    return run.catch((err: unknown) => {
      log.warn("Could not settle agent addresses", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    observe(sightings) {
      if (sightings.length === 0) return Promise.resolve();
      return guarded(
        (async () => {
          if (deps.list && listedAt === Number.NEGATIVE_INFINITY && !quiet()) {
            await waited(prime(deps.list).catch(() => {}));
          }
          const disputed = await serial(async () => settle(sightings));
          // A message never outranks a listing, so when one disagrees with
          // what a listing recorded, as after a rename, Cloud is asked again
          // before the message is read. One read answers each disagreement
          // for a while, and a message whose disagreement is being read waits
          // for that read.
          if (disputed.length === 0 || !deps.list) return;
          const askedAt = now();
          for (const [key, at] of relisted) if (askedAt - at >= RELIST_MS) relisted.delete(key);
          const open = disputed.filter(({ key }) => !relisted.has(key));
          if (open.length > 0) await decide(deps.list, open, askedAt);
        })(),
      );
    },
    observeListing(sightings, askedAt) {
      return guarded(serial(async () => settleListing(sightings, askedAt)));
    },
    prime() {
      return deps.list ? guarded(prime(deps.list)) : Promise.resolve();
    },
    serial,
  };
}
