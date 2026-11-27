import type { ActionRegistry } from "../apps/actions/types.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import type { LiveEventEmit } from "../lib/live-event.js";
import { applyAgentName } from "../instance/guardian-profile/index.js";

export interface AgentNameEvents {
  subscribe(emit: LiveEventEmit): () => void;
}

/** Registers the agent's rename action and its dashboard notifications. */
export function registerAgentNameAction(
  actions: Pick<ActionRegistry, "register">,
  deps: {
    settingsRepo: Pick<SettingsRepository, "set">;
  },
): AgentNameEvents {
  const listeners = new Set<LiveEventEmit>();
  actions.register({
    config: {
      name: "core:set_agent_name",
      type: "system",
      description:
        "Change your own name when asked. Saves the agent name setting and the Agent Name line in IDENTITY.md together and refreshes the dashboard.",
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
