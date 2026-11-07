import { createPromptSources, createSystemPrompts, type SystemPrompts } from "../agent/index.js";

type PromptSourceOptions = Parameters<typeof createPromptSources>[0];

const noApps: PromptSourceOptions["apps"] = {
  listResolved: () => [],
  subscribe: () => () => {},
};

/** The production system prompts, reading a test's profile. No apps unless given. */
export function createTestSystemPrompts(options: Partial<PromptSourceOptions> = {}): SystemPrompts {
  return createSystemPrompts({ sources: createPromptSources({ apps: noApps, ...options }) });
}
