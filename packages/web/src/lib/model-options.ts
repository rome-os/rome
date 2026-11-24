import { modelDisplayName } from "./model-display";

// Model picker contract: docs/domains/agents.md#model-selection.
// lint/model-selection-catalog.test.ts checks these wire identities against the agent domain.
export const LARGE_MODEL_OPTIONS = [
  { id: "auto", providerId: null, model: null },
  {
    id: "claude-opus",
    providerId: "anthropic",
    model: "claude-opus-4-8[1m]",
  },
  {
    id: "claude-opus-5-5",
    providerId: "anthropic",
    model: "claude-opus-5-5[1m]",
  },
  {
    id: "claude-opus-5",
    providerId: "anthropic",
    model: "claude-opus-5[1m]",
  },
  {
    id: "claude-opus-4-6",
    providerId: "anthropic",
    model: "claude-opus-4-6[1m]",
  },
  {
    id: "claude-sonnet",
    providerId: "anthropic",
    model: "claude-sonnet-5-5",
  },
  {
    id: "claude-haiku",
    providerId: "anthropic",
    model: "claude-haiku-5-5",
  },
  {
    id: "claude-fable",
    providerId: "anthropic",
    model: "claude-fable-5-1[1m]",
  },
  {
    id: "gpt-6-astra",
    providerId: "openai",
    model: "gpt-6-astra",
  },
  {
    id: "gpt-6-1-sol",
    providerId: "openai",
    model: "gpt-6.1-sol",
  },
  {
    id: "gpt-6-sol",
    providerId: "openai",
    model: "gpt-6-sol",
  },
  {
    id: "gpt-6-luna",
    providerId: "openai",
    model: "gpt-6-luna",
  },
  {
    id: "gpt-5-6-sol",
    providerId: "openai",
    model: "gpt-5.6-sol",
  },
  {
    id: "gpt-5-6-terra",
    providerId: "openai",
    model: "gpt-5.6-terra",
  },
  {
    id: "gpt-5-6-luna",
    providerId: "openai",
    model: "gpt-5.6-luna",
  },
] as const;

export function modelOptionLabel(
  option: (typeof LARGE_MODEL_OPTIONS)[number],
  autoLabel: string,
): string {
  return option.model === null ? autoLabel : modelDisplayName(option.model);
}
