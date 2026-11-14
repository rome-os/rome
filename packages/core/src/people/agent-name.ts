import { askedByGuardian } from "../apps/actions/guardian-turn.js";
import type { ActionRegistry } from "../apps/actions/types.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { LiveEventEmit } from "../lib/live-event.js";
import { applyAgentName } from "./guardian-profile.js";

export interface AgentNameEvents {
  subscribe(emit: LiveEventEmit): () => void;
}

/** Registers the guardian's rename action and its dashboard notifications. */
export function registerAgentNameAction(
  actions: Pick<ActionRegistry, "register">,
  deps: {
    settingsRepo: Pick<SettingsRepository, "set">;
    /** Whose chat it is ("guardian" or "visitor:<account>"), or null for a chat that no longer exists. */
    ownerOfChat(chatId: string | null | undefined): Promise<string | null>;
  },
): AgentNameEvents {
  const listeners = new Set<LiveEventEmit>();
  actions.register({
    config: {
      name: "core:set_agent_name",
      type: "system",
      description:
        "Change your own name when the guardian asks. Saves the agent name setting and the Agent Name line in IDENTITY.md together and refreshes the dashboard. Guardian only.",
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string", description: "A single-line name, up to 60 characters." },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (!(await askedByGuardian(deps.ownerOfChat))) {
        return { status: "error", error: "Only the guardian can change the agent name." };
      }
      if (typeof args.name !== "string" || /[\r\n\u2028\u2029]/u.test(args.name)) {
        return { status: "error", error: "Agent name must be a single line of text." };
      }
      const agentName = args.name.trim();
      if (!agentName || Array.from(agentName).length > 60) {
        return {
          status: "error",
          error: "Agent name must contain 1 to 60 characters after trimming.",
        };
      }
      try {
        await applyAgentName(agentName, deps.settingsRepo);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { status: "error", error: `Could not save the agent name: ${reason}` };
      }
      for (const emit of listeners) emit("agent_name_changed", { agentName });
      return { status: "ok", data: { agentName } };
    },
  });
  return {
    subscribe(emit) {
      listeners.add(emit);
      return () => {
        listeners.delete(emit);
      };
    },
  };
}
