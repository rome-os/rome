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
 * - An address now held by a different endpoint loses the old endpoint's link,
 *   so the new one starts unlinked and is never taken for the old one's person.
 *
 * Conversation history stays under the address it was written to. An endpoint
 * first seen here takes over whatever its address already holds, since Rome
 * cannot tell which endpoint held it before Cloud named endpoints.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { AgentMessageEnvelope } from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";
import { AGENTS_GUARDIAN_LINKED_KEY } from "./agents-guardian.js";

const log = createLogger("agents-identity");

/** The settings key holding the address each endpoint was last seen under. */
export const AGENTS_ENDPOINT_ADDRESSES_KEY = "agentsEndpointAddresses";

/** One endpoint as Cloud names it. */
export interface AgentSighting {
  endpointId: string;
  address: string;
}

/** The endpoint an inbound message names, when Cloud gives its id. */
export function agentSightings(message: ChannelMessage): AgentSighting[] {
  const endpointId = (message.raw as Partial<AgentMessageEnvelope> | undefined)?.from?.endpointId;
  return endpointId ? [{ endpointId, address: message.senderId }] : [];
}

export interface AgentsIdentity {
  /** Settles what the sightings change. Never throws. */
  observe(sightings: readonly AgentSighting[]): Promise<void>;
  /** Runs `fn` after every earlier settlement, and before any later one. The
   *  guardian link runs here, because both rewrite the guardian's record. */
  serial<T>(fn: () => Promise<T>): Promise<T>;
}

export function createAgentsIdentity(deps: {
  personMappingRepo: Pick<
    PersonMappingRepository,
    "findByChannelUser" | "updateChannelUserId" | "deleteChannelMapping"
  >;
  settingsRepo: Pick<SettingsRepository, "get" | "set">;
  channel: string;
}): AgentsIdentity {
  let queue: Promise<unknown> = Promise.resolve();

  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  }

  async function settle(sightings: readonly AgentSighting[]): Promise<void> {
    const seen =
      (await deps.settingsRepo.get<Record<string, string>>(AGENTS_ENDPOINT_ADDRESSES_KEY)) ?? {};
    const linked = (await deps.settingsRepo.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)) ?? [];
    const addresses = { ...seen };
    let guardianRecord = linked;
    for (const { endpointId, address } of sightings) {
      const before = addresses[endpointId];
      if (before === address) continue;
      const holder = Object.keys(addresses).find(
        (id) => id !== endpointId && addresses[id] === address,
      );
      if (holder !== undefined) {
        // Cloud gives an address to one endpoint at a time, so the endpoint
        // that held it is gone, and so is any claim its link had on it.
        delete addresses[holder];
        await deps.personMappingRepo.deleteChannelMapping(deps.channel, address);
        log.info("an agent address passed to a new endpoint; its old link was dropped", {
          address,
        });
      }
      if (before !== undefined) {
        const person = await deps.personMappingRepo.findByChannelUser(deps.channel, before);
        if (person) {
          await deps.personMappingRepo.updateChannelUserId(
            person.id,
            deps.channel,
            before,
            address,
          );
        }
        log.info("an agent moved to a new address with its link", { from: before, to: address });
      } else if (guardianRecord.includes(address)) {
        // Recorded by address before Cloud named endpoints. The record now
        // names the endpoint, so it stays with it through a rename and does
        // not hold back a new endpoint that reuses the name.
        guardianRecord = guardianRecord.map((entry) => (entry === address ? endpointId : entry));
      }
      addresses[endpointId] = address;
    }
    if (guardianRecord !== linked) {
      await deps.settingsRepo.set(AGENTS_GUARDIAN_LINKED_KEY, guardianRecord);
    }
    if (JSON.stringify(addresses) !== JSON.stringify(seen)) {
      await deps.settingsRepo.set(AGENTS_ENDPOINT_ADDRESSES_KEY, addresses);
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
