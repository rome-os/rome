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
 * The record is written before the links change, and marks a link it is
 * about to take off until it is off, so a settlement that fails partway is
 * finished by the next one.
 *
 * Cloud's listing is its current state and always settles. A message is as old
 * as when it was sent, and settles an endpoint only against what earlier
 * messages said of it, never against a listing, so a message Cloud held while
 * Rome was offline cannot undo a rename the listing already settled. A message
 * that disagrees with a listing has Cloud listed again before it is read, so a
 * rename still reaches the person on its first message. Rome's clock and
 * Cloud's are never compared.
 *
 * Conversation history stays under the address it was written to. An endpoint
 * first seen here takes over whatever its address already holds, since Rome
 * cannot tell which endpoint held it before Cloud named endpoints.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
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
  /** A link this endpoint is taking off an address, until it is off. */
  clearing?: { from: string; person: string };
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

/** The part of an endpoint's record a sighting sets. */
function seenBy(sighting: AgentSighting): Pick<Known, "by" | "at"> {
  return sighting.by === "message" ? { by: "message", at: sighting.at } : { by: "listing" };
}

export function createAgentsIdentity(deps: {
  personMappingRepo: Pick<
    PersonMappingRepository,
    "findByChannelUser" | "deleteChannelMapping" | "addChannelMapping"
  >;
  settingsRepo: Pick<SettingsRepository, "get" | "set">;
  channel: string;
  /** Reads Cloud's listing now, for a message that disagrees with an earlier
   *  one. Null when Cloud cannot be read. */
  list?: () => Promise<AgentSighting[] | null>;
}): AgentsIdentity {
  let queue: Promise<unknown> = Promise.resolve();
  const repo = deps.personMappingRepo;
  const channel = deps.channel;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  /** Settles the sightings, and says whether a message disagreed with a
   *  listing. */
  async function settle(sightings: readonly AgentSighting[]): Promise<boolean> {
    let disputed = false;
    const known: Record<string, Known> =
      (await deps.settingsRepo.get<Record<string, Known>>(AGENTS_ENDPOINTS_KEY)) ?? {};
    let saved = JSON.stringify(known);
    const holders = new Map<string, string>();
    for (const [id, entry] of Object.entries(known)) {
      if (entry.address !== null) holders.set(entry.address, id);
    }

    async function save(): Promise<void> {
      for (const [id, entry] of Object.entries(known)) {
        if (entry.address === null && !entry.parked && !entry.clearing) delete known[id];
      }
      const next = JSON.stringify(known);
      if (next === saved) return;
      await deps.settingsRepo.set(AGENTS_ENDPOINTS_KEY, known);
      saved = next;
    }

    /** Takes an endpoint's link off the address it is leaving, keeping it on
     *  the endpoint's record. */
    async function leave(id: string, from: string): Promise<void> {
      const person = await repo.findByChannelUser(channel, from);
      const entry = known[id];
      known[id] = {
        ...entry,
        address: null,
        ...(person
          ? { parked: person.id, parkedFrom: from, clearing: { from, person: person.id } }
          : {}),
      };
      holders.delete(from);
      await save();
      if (person) {
        await clear(id);
        log.info("an agent left its address; its link waits for it", { address: from });
      }
    }

    /** Takes off the link an endpoint is marked as clearing, if it is still
     *  there, then drops the mark. */
    async function clear(id: string): Promise<void> {
      const entry = known[id];
      if (!entry?.clearing) return;
      const { clearing, ...rest } = entry;
      if ((await repo.findByChannelUser(channel, clearing.from))?.id === clearing.person) {
        await repo.deleteChannelMapping(channel, clearing.from);
      }
      known[id] = rest;
      await save();
    }

    /** Gives an endpoint's waiting link back at its current address. */
    async function restore(id: string): Promise<void> {
      const entry = known[id];
      if (!entry?.parked || !entry.parkedFrom || entry.address === null) return;
      if (isOwn(entry.parkedFrom) !== isOwn(entry.address)) {
        log.warn("an agent moved between accounts; its link stays behind", {
          from: entry.parkedFrom,
          to: entry.address,
        });
        return;
      }
      const { parked, parkedFrom: _from, ...rest } = entry;
      if (!(await repo.findByChannelUser(channel, entry.address))) {
        await repo.addChannelMapping(parked, channel, entry.address);
        log.info("an agent's link followed it to its new address", { to: entry.address });
      }
      known[id] = rest;
      await save();
    }

    // Finishes what a settlement that stopped partway left marked.
    for (const id of Object.keys(known)) await clear(id);

    let guardianRecord = (await deps.settingsRepo.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)) ?? [];

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
        disputed ||= disputes(sighting, entry);
        continue;
      }
      if (entry?.address === address) {
        if (sighting.by === "listing" || entry.by === "message") {
          known[endpointId] = { ...entry, ...seenBy(sighting) };
        }
        await save();
        await restore(endpointId);
        continue;
      }
      const holder = holders.get(address);
      if (holder !== undefined && holder !== endpointId) {
        // A message never takes an address from an endpoint a listing put
        // there; only a fresh listing can say it moved.
        if (sighting.by === "message" && known[holder]?.by === "listing") {
          disputed = true;
          continue;
        }
        if (staleAgainst(sighting, known[holder])) continue;
        // Cloud gives an address to one endpoint at a time, so the one that
        // held it has left, whether removed or renamed.
        await leave(holder, address);
      }

      if (entry?.address && entry.address !== address) {
        await leave(endpointId, entry.address);
      } else if (!entry && guardianRecord.includes(address)) {
        // Recorded by address before Cloud named endpoints. The record now
        // names the endpoint, so it stays with it through a rename and does
        // not hold back a new endpoint that reuses the name.
        guardianRecord = guardianRecord.map((name) => (name === address ? endpointId : name));
        await deps.settingsRepo.set(AGENTS_GUARDIAN_LINKED_KEY, guardianRecord);
      }
      known[endpointId] = { ...known[endpointId], address, ...seenBy(sighting) };
      holders.set(address, endpointId);
      await save();
      await restore(endpointId);
    }
    return disputed;
  }

  return {
    observe(sightings) {
      if (sightings.length === 0) return Promise.resolve();
      return serial(async () => {
        // A message never outranks a listing, so when one disagrees with what
        // a listing recorded, as after a rename, Cloud is asked again before
        // the message is read.
        if (!(await settle(sightings)) || !deps.list) return;
        const listing = await deps.list();
        if (listing) await settle(listing);
      }).catch((err: unknown) => {
        log.warn("Could not settle agent addresses", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    serial,
  };
}
