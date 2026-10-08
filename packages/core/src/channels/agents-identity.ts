/**
 * Keeps the Agents channel's links on the endpoint they were made for. An
 * agent's account id is its address, because that is what Rome Cloud sends to,
 * but an address is not stable: a linked account's owner can change its
 * handle, and a removed endpoint's name can return under a new endpoint. Cloud
 * also names each endpoint by an `endpointId` that never changes, so Rome
 * records which endpoint last held each address and settles every change it
 * sees, from an inbound message or from Cloud's listing:
 *
 * - An endpoint seen under a new address takes its person link with it.
 * - An address now held by a different endpoint no longer carries the old
 *   endpoint's link, so the new one starts unlinked and is never taken for the
 *   old one's person. The link is kept aside for the old endpoint, which may
 *   only have been renamed, and goes back to it wherever it shows up.
 * - A link never moves between this Rome's own account and another one, so a
 *   renamed endpoint cannot carry the guardian's trust across accounts.
 *
 * Each sighting carries when it held: a listing is now, a message is when it
 * was sent. A sighting older than what Rome already knows of an endpoint or of
 * an address changes nothing, so a message Cloud held while Rome was offline
 * cannot undo a rename the listing already settled.
 *
 * Conversation history stays under the address it was written to. An endpoint
 * first seen here takes over whatever its address already holds, since Rome
 * cannot tell which endpoint held it before Cloud named endpoints.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { type AgentMessageEnvelope, agentAddressAccount } from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import { AGENTS_GUARDIAN_LINKED_KEY } from "./agents-guardian.js";

const log = createLogger("agents-identity");

/** The settings key holding what Rome last knew of each endpoint. */
export const AGENTS_ENDPOINTS_KEY = "agentsEndpoints";

/** What Rome last knew of an endpoint. */
interface Known {
  /** The address it held, or null once another endpoint took it. */
  address: string | null;
  /** When that held, in epoch milliseconds. */
  at: number;
  /** The person its link was on when another endpoint took its address. */
  parked?: string;
}

/** One endpoint as Cloud names it, and when that held. */
export interface AgentSighting {
  endpointId: string;
  address: string;
  at: number;
}

/** The endpoint an inbound message names, when Cloud gives its id. */
export function agentSightings(message: ChannelMessage): AgentSighting[] {
  const envelope = message.raw as Partial<AgentMessageEnvelope> | undefined;
  const endpointId = envelope?.from?.endpointId;
  const at = Date.parse(envelope?.sentAt ?? "");
  return endpointId && !Number.isNaN(at) ? [{ endpointId, address: message.senderId, at }] : [];
}

export interface AgentsIdentity {
  /** Settles what the sightings change. Never throws. */
  observe(sightings: readonly AgentSighting[]): Promise<void>;
  /** Runs `fn` after every earlier settlement, and before any later one. The
   *  guardian link runs here, because both rewrite the guardian's record. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
}

const isOwn = (address: string) => agentAddressAccount(address) === null;

export function createAgentsIdentity(deps: {
  personMappingRepo: Pick<
    PersonMappingRepository,
    "findByChannelUser" | "updateChannelUserId" | "deleteChannelMapping" | "addChannelMapping"
  >;
  settingsRepo: Pick<SettingsRepository, "get" | "set">;
  channel: string;
}): AgentsIdentity {
  let queue: Promise<unknown> = Promise.resolve();
  const repo = deps.personMappingRepo;

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function settle(sightings: readonly AgentSighting[]): Promise<void> {
    const stored = (await deps.settingsRepo.get<Record<string, Known>>(AGENTS_ENDPOINTS_KEY)) ?? {};
    const linked = (await deps.settingsRepo.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)) ?? [];
    const known: Record<string, Known> = { ...stored };
    const holders = new Map<string, string>();
    for (const [id, entry] of Object.entries(known)) {
      if (entry.address !== null) holders.set(entry.address, id);
    }
    let guardianRecord = linked;

    // An endpoint Rome knows goes first, so one renamed within a listing has
    // left its old address before a new endpoint is seen taking it.
    const ordered = [...sightings].sort(
      (a, b) =>
        Number(known[b.endpointId] !== undefined) - Number(known[a.endpointId] !== undefined),
    );
    for (const { endpointId, address, at } of ordered) {
      const entry = known[endpointId];
      if (entry && (entry.at > at || entry.address === address)) {
        if (entry.address === address && entry.at < at) known[endpointId] = { ...entry, at };
        continue;
      }
      const holder = holders.get(address);
      const held = holder !== undefined && holder !== endpointId ? known[holder] : undefined;
      if (holder !== undefined && held && held.at > at) continue;

      if (holder !== undefined && held) {
        // Cloud gives an address to one endpoint at a time. The one that held
        // it is gone or renamed, and its link waits for it rather than passing
        // to the endpoint that took the address.
        const person = await repo.findByChannelUser(deps.channel, address);
        await repo.deleteChannelMapping(deps.channel, address);
        known[holder] = { address: null, at, ...(person ? { parked: person.id } : {}) };
        holders.delete(address);
        log.info("an agent address passed to a new endpoint; its old link was set aside", {
          address,
        });
      }

      if (entry?.address && entry.address !== address) {
        const from = entry.address;
        holders.delete(from);
        const person = await repo.findByChannelUser(deps.channel, from);
        if (person && isOwn(from) !== isOwn(address)) {
          log.warn("an agent moved between accounts; its link stays behind", {
            from,
            to: address,
          });
        } else if (person) {
          await repo.updateChannelUserId(person.id, deps.channel, from, address);
          log.info("an agent moved to a new address with its link", { from, to: address });
        }
      } else if (entry?.parked) {
        if (!(await repo.findByChannelUser(deps.channel, address))) {
          await repo.addChannelMapping(entry.parked, deps.channel, address);
          log.info("an agent's set-aside link went back to it", { address });
        }
      } else if (!entry && guardianRecord.includes(address)) {
        // Recorded by address before Cloud named endpoints. The record now
        // names the endpoint, so it stays with it through a rename and does
        // not hold back a new endpoint that reuses the name.
        guardianRecord = guardianRecord.map((name) => (name === address ? endpointId : name));
      }
      known[endpointId] = { address, at };
      holders.set(address, endpointId);
    }

    if (guardianRecord !== linked) {
      await deps.settingsRepo.set(AGENTS_GUARDIAN_LINKED_KEY, guardianRecord);
    }
    if (JSON.stringify(known) !== JSON.stringify(stored)) {
      await deps.settingsRepo.set(AGENTS_ENDPOINTS_KEY, known);
    }
  }

  return {
    observe(sightings) {
      if (sightings.length === 0) return Promise.resolve();
      return serial(() => settle(sightings)).catch((err: unknown) => {
        log.warn("Could not settle agent addresses", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    serial,
  };
}
