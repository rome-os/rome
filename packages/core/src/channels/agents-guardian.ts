/**
 * Links the guardian's own agents to the guardian. An agent in this Rome's
 * Rome Cloud account belongs to the account holder: a dot exists only once the
 * person has signed in to Rome Cloud from ChatGPT, and it is Cloud, not the
 * sender, that marks a message `sameAccount`. So the first message from such an agent
 * links its `agents` account to the guardian before the inbox resolves the
 * sender, and the dot speaks as the guardian from that message on.
 *
 * Only an account nobody has decided about is linked. A link to anyone, a
 * dismissal, or an earlier automatic link the guardian has since removed all
 * stand. Unlinking leaves no row behind, so Rome records the agent id of
 * each agent it linked here and never links it again, whatever it is renamed
 * to, while a new agent that takes a removed one's name is linked anew.
 */

import type { ChannelMessage } from "@rome-os/app-runtime";
import type { PersonMappingRepository } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { AgentMessageEnvelope } from "../lib/rome-cloud-agents.js";
import { createLogger } from "../logger.js";

const log = createLogger("agents-guardian");

/** The settings key holding every agent this admission has linked. */
export const AGENTS_GUARDIAN_LINKED_KEY = "agentsGuardianLinkedAgentIds";

function isSameAccount(message: ChannelMessage): boolean {
  const from = (message.raw as Partial<AgentMessageEnvelope> | undefined)?.from;
  return from?.sameAccount === true && from.agentId === message.senderId;
}

export function createAgentsGuardianLink(deps: {
  personMappingRepo: Pick<
    PersonMappingRepository,
    "findByChannelUser" | "findByBondLevel" | "addChannelMapping"
  >;
  settingsRepo: Pick<SettingsRepository, "get" | "set">;
  channel: string;
}) {
  // Admission takes different senders at once, and the record of linked
  // agents is one setting, so its read and write run one sender at a time.
  let queue: Promise<unknown> = Promise.resolve();

  async function link(message: ChannelMessage): Promise<void> {
    const agent = message.senderId;
    if (await deps.personMappingRepo.findByChannelUser(deps.channel, agent)) return;
    const linked = (await deps.settingsRepo.get<string[]>(AGENTS_GUARDIAN_LINKED_KEY)) ?? [];
    if (linked.includes(agent)) return;
    const [guardian] = await deps.personMappingRepo.findByBondLevel("guardian");
    if (!guardian) return;
    // The record goes first. If the link then fails, the agent stays
    // unlinked, which is the guardian's call to change. The other order could
    // leave a link that the guardian's unlink does not keep removed.
    await deps.settingsRepo.set(AGENTS_GUARDIAN_LINKED_KEY, [...linked, agent]);
    await deps.personMappingRepo.addChannelMapping(
      guardian.id,
      deps.channel,
      agent,
      message.senderDisplayName,
    );
    log.info("linked a same-account agent to the guardian", { agentId: agent });
  }

  /** Links the sender when it qualifies. Never refuses the message. */
  return (message: ChannelMessage): Promise<void> => {
    if (!isSameAccount(message)) return Promise.resolve();
    const run = queue.then(() => link(message));
    queue = run.catch((err: unknown) => {
      log.warn("Could not link a same-account agent", {
        agentId: message.senderId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return queue as Promise<void>;
  };
}
