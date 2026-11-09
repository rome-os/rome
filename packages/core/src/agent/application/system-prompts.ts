import {
  buildPromptPrefix,
  buildSystemPrompt,
  carriesMemory,
  type PromptAgent,
  type PromptSources,
} from "../domain/system-prompt.js";
import type { WidgetDrawing } from "../domain/widget-drawing.js";

interface PromptOptions {
  contextSuffix?: string;
  widgets: WidgetDrawing;
}

/** Builds the system prompt for an agent's session. */
export interface SystemPrompts {
  build(agent: PromptAgent, options: PromptOptions): string;
  /**
   * The system prompt `build` gives, without memory, from the sources as they
   * are now: what a session's setup holds of its prompt. The caller leaves
   * out the opener's context suffix when it is living context, such as the
   * guardian's profile. When the fixed part
   * changed since it was held, the new one is held, so the next `build` uses
   * it too.
   */
  setup(agent: PromptAgent, options: PromptOptions): string;
}

/** Holds each agent's fixed part until the sources change, and reads memory on every build. */
export function createSystemPrompts(options: { sources: PromptSources }): SystemPrompts {
  const { sources } = options;
  const prefixes = new Map<string, string>();
  sources.onChanged(() => prefixes.clear());
  const keyOf = (agent: PromptAgent) => `${agent.owner}:${agent.name}`;

  return {
    build(agent, { contextSuffix, widgets }) {
      const key = keyOf(agent);
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
    setup(agent, { contextSuffix, widgets }) {
      // Read again, since a file the fixed part quotes, such as the
      // identity, changes without telling the sources.
      const prefix = buildPromptPrefix(agent, sources.material());
      prefixes.set(keyOf(agent), prefix);
      return buildSystemPrompt({
        prefix,
        owner: agent.owner,
        memory: null,
        contextSuffix,
        widgets,
      });
    },
  };
}
