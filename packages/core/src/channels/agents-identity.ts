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
 * asked for later has already settled. A message is as old
 * as when it was sent, and settles an endpoint only against what earlier
 * messages said of it, never against a listing, so a message Cloud held while
 * Rome was offline cannot undo a rename the listing already settled. A message
 * that disagrees with a listing has Cloud listed again before it is read, so a
 * rename still reaches the person on its first message. The same disagreement
 * is listed again at most once a half minute, so a run of held-back messages
 * reads Cloud once. Rome waits for Cloud outside the settlement queue, so other
 * agents' messages are not held up. Rome's clock and Cloud's are never
 * compared.
 *
 * Conversation history stays under the address it was written to. An endpoint
 * first seen here takes over whatever its address already holds, since Rome
 * cannot tell which endpoint held it before Cloud named endpoints.
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
import { AGENTS_GUARDIAN_LINKED_KEY } from "./agents-guardian.js";

const log = createLogger("agents-identity");

/** How long a listing read for one disagreement answers it again, matching
 *  how long the People page keeps one read. */
const RELIST_MS = 30_000;

/** The settings key holding what Rome last knew of each endpoint. */
export const AGENTS_ENDPOINTS_KEY = "agentsEndpoints";

/** What Rome last knew of an endpoint. */
interface Known {
  /** The address it holds, or null after it left one and none is known yet. */
  address: string | null;
  /** Where that came from, and for a message, when it was sent. */
  by: "listing" | "message";
  at?: number;
  /** The person whose link it took off `parkedFrom`, waiting to go back. */
  parked?: string;
  parkedFrom?: string;
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

/** The endpoints a listing names by id. */
export function listingSightings(endpoints: readonly AgentEndpointSummary[]): AgentSighting[] {
  return endpoints.flatMap((endpoint) => {
    const address = agentAddress(endpoint);
    return endpoint.endpointId && address !== null
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
  /** Runs `fn` after every earlier settlement, and before any later one. The
   *  guardian link runs here, because both rewrite the guardian's record. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
}

const isOwn = (address: string) => agentAddressAccount(address) === null;

/** Whether a message's sighting is older than what Rome knows of `entry`. */
function staleAgainst(sighting: AgentSighting, entry: Known | undefined): boolean {
  if (sighting.by === "listing" || !entry) return false;
  if (entry.by === "listing") return entry.address !== sighting.address;
  return (entry.at ?? 0) > sighting.at;
}

/** Whether a message disagrees with what a listing recorded, which only a
 *  fresh listing can settle. */
function disputes(sighting: AgentSighting, entry: Known | undefined): boolean {
  return sighting.by === "message" && entry?.by === "listing" && entry.address !== sighting.address;
}

/** Names one disagreement, so the same one is listed again only so often. */
const disputeKey = (sighting: AgentSighting) => `${sighting.endpointId} ${sighting.address}`;

/** The part of an endpoint's record a sighting sets. */
function seenBy(sighting: AgentSighting): Pick<Known, "by" | "at"> {
  return sighting.by === "message" ? { by: "message", at: sighting.at } : { by: "listing" };
}

export function createAgentsIdentity(deps: {
  db: Pick<DrizzleDb, "transaction">;
  personMappingRepo: Pick<
    PersonMappingRepository,
    "readChannelHolder" | "writeChannelMapping" | "writeUnlinkAccount"
  >;
  settingsRepo: Pick<SettingsRepository, "read" | "write">;
  channel: string;
  /** Reads Cloud's listing now, for a message that disagrees with an earlier
   *  one. Null when Cloud cannot be read. */
  list?: () => Promise<AgentSighting[] | null>;
  now?: () => number;
}): AgentsIdentity {
  const now = deps.now ?? Date.now;
  const repo = deps.personMappingRepo;
  const settings = deps.settingsRepo;
  const channel = deps.channel;
  let queue: Promise<unknown> = Promise.resolve();
  /** When the newest listing settled so far was asked for. */
  let listedAt = Number.NEGATIVE_INFINITY;
  /** When each disagreement last had Cloud listed again. */
  const relisted = new Map<string, number>();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Settles the sightings, and returns the disagreements between a message
   *  and a listing. */
  function settle(sightings: readonly AgentSighting[]): string[] {
    return deps.db.transaction((tx) => {
      const disputed: string[] = [];
      const known = settings.read<Record<string, Known>>(tx, AGENTS_ENDPOINTS_KEY) ?? {};
      const before = JSON.stringify(known);
      let guardianRecord = settings.read<string[]>(tx, AGENTS_GUARDIAN_LINKED_KEY) ?? [];
      const holders = new Map<string, string>();
      for (const [id, entry] of Object.entries(known)) {
        if (entry.address !== null) holders.set(entry.address, id);
      }
      const holderOf = (address: string) => repo.readChannelHolder(tx, channel, address);

      /** Takes an endpoint's link off the address it is leaving, keeping it on
       *  the endpoint's record. */
      function leave(id: string, from: string): void {
        const person = holderOf(from);
        known[id] = {
          ...known[id],
          address: null,
          ...(person ? { parked: person, parkedFrom: from } : {}),
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
        const { parked, parkedFrom: _from, ...rest } = entry;
        known[id] = rest;
        if (isOwn(entry.parkedFrom) !== isOwn(entry.address)) {
          // It can never go back, so it stops waiting.
          log.warn("an agent moved between accounts; its link stays off", {
            from: entry.parkedFrom,
            to: entry.address,
          });
        } else if (holderOf(entry.address) === null) {
          repo.writeChannelMapping(tx, parked, channel, entry.address);
          log.info("an agent's link followed it to its new address", { to: entry.address });
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
        if (staleAgainst(sighting, entry)) {
          if (disputes(sighting, entry)) disputed.push(disputeKey(sighting));
          continue;
        }
        if (entry?.address === address) {
          if (sighting.by === "listing" || entry.by === "message") {
            known[endpointId] = { ...entry, ...seenBy(sighting) };
          }
          restore(endpointId);
          continue;
        }
        const holder = holders.get(address);
        if (holder !== undefined && holder !== endpointId) {
          // A message never takes an address from an endpoint a listing put
          // there; only a fresh listing can say it moved.
          if (sighting.by === "message" && known[holder]?.by === "listing") {
            disputed.push(disputeKey(sighting));
            continue;
          }
          if (staleAgainst(sighting, known[holder])) continue;
          // Cloud gives an address to one endpoint at a time, so the one that
          // held it has left, whether removed or renamed.
          leave(holder, address);
        }

        if (entry?.address && entry.address !== address) {
          leave(endpointId, entry.address);
        } else if (!entry && guardianRecord.includes(address)) {
          // Recorded by address before Cloud named endpoints. The record now
          // names the endpoint, so it stays with it through a rename and does
          // not hold back a new endpoint that reuses the name.
          guardianRecord = guardianRecord.map((name) => (name === address ? endpointId : name));
          settings.write(tx, AGENTS_GUARDIAN_LINKED_KEY, guardianRecord);
        }
        known[endpointId] = { ...known[endpointId], address, ...seenBy(sighting) };
        holders.set(address, endpointId);
        restore(endpointId);
      }

      for (const [id, entry] of Object.entries(known)) {
        if (entry.address === null && !entry.parked) delete known[id];
      }
      if (JSON.stringify(known) !== before) settings.write(tx, AGENTS_ENDPOINTS_KEY, known);
      return disputed;
    });
  }

  /** Settles a listing unless a later-asked one already has. */
  function settleListing(listing: readonly AgentSighting[], askedAt: number): void {
    if (askedAt < listedAt) return;
    listedAt = askedAt;
    settle(listing);
  }

  /** Whether any of these disagreements has not had Cloud listed again lately,
   *  marking them all as listed now when one has not. */
  function relist(disputed: readonly string[], askedAt: number): boolean {
    for (const [key, at] of relisted) if (askedAt - at >= RELIST_MS) relisted.delete(key);
    if (disputed.every((key) => relisted.has(key))) return false;
    for (const key of disputed) relisted.set(key, askedAt);
    return true;
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
          const disputed = await serial(async () => settle(sightings));
          // A message never outranks a listing, so when one disagrees with
          // what a listing recorded, as after a rename, Cloud is asked again
          // before the message is read.
          if (disputed.length === 0 || !deps.list) return;
          const askedAt = now();
          if (!relist(disputed, askedAt)) return;
          const listing = await deps.list();
          if (listing) await serial(async () => settleListing(listing, askedAt));
        })(),
      );
    },
    observeListing(sightings, askedAt) {
      return guarded(serial(async () => settleListing(sightings, askedAt)));
    },
    serial,
  };
}
