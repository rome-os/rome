import {
  buildPromptPrefix,
  buildSystemPrompt,
  carriesMemory,
  type PromptAgent,
  type PromptSources,
} from "../domain/system-prompt.js";
import type { WidgetDrawing } from "../domain/widget-drawing.js";

/** Builds the system prompt for an agent's session. */
export interface SystemPrompts {
  build(agent: PromptAgent, options: { contextSuffix?: string; widgets: WidgetDrawing }): string;
}

/** Holds each agent's fixed part until the sources change, and reads memory on every build. */
export function createSystemPrompts(options: { sources: PromptSources }): SystemPrompts {
  const { sources } = options;
  const prefixes = new Map<string, string>();
  sources.onChanged(() => prefixes.clear());

  return {
    build(agent, { contextSuffix, widgets }) {
      const key = `${agent.owner}:${agent.name}`;
      const prefix = prefixes.get(key) ?? buildPromptPrefix(agent, sources.material());
      prefixes.set(key, prefix);
      return buildSystemPrompt({
        prefix,
        owner: agent.owner,
        memory: carriesMemory(agent) ? sources.memory() : null,
        contextSuffix,
        widgets,
      });
    },
  };
}
