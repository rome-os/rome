import type { ConciergeService } from "../concierge/service.js";
import { actionExecutionContext } from "../apps/actions/context.js";
import type { ActionRegistry } from "../apps/actions/types.js";
import type { LiveEventEmit } from "../lib/live-event.js";
import { applyGuardianProfile, type GuardianProfileDeps } from "./guardian-profile.js";

export interface AgentNameEvents {
  subscribe(emit: LiveEventEmit): () => void;
}

/** Registers the guardian's rename action and its dashboard notifications. */
export function registerAgentNameAction(
  actions: Pick<ActionRegistry, "register">,
  deps: GuardianProfileDeps & Pick<ConciergeService, "ownerOfChat">,
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
      const context = actionExecutionContext.getStore();
      const actor = context?.actor;
      if (actor && actor.kind !== "guardian") {
        return { status: "error", error: "Only the guardian can change the agent name." };
      }
      // Autonomous Concierge turns have no session actor. Use the stored chat
      // owner, never the model's concierge_owner text, to authorize those too.
      const thread = context?.channelContext;
      const owner =
        thread?.channel === "webchat" && thread.threadId
          ? await deps.ownerOfChat(thread.threadId)
          : null;
      if (
        (thread?.channel === "webchat" && owner !== "guardian") ||
        (!actor && owner !== "guardian")
      ) {
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
      const result = await applyGuardianProfile({ agentName }, deps);
      if (!result.ok) {
        return { status: "error", error: "Set the guardian name before changing the agent name." };
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
