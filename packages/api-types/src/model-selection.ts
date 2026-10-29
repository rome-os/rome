export type WebchatLargeModelSelectionId =
  | "auto"
  | "claude-opus"
  | "claude-opus-5-5"
  | "claude-opus-5"
  | "claude-opus-4-6"
  | "claude-sonnet"
  | "claude-haiku"
  | "claude-fable"
  | "gpt-6-astra"
  | "gpt-6-1-sol"
  | "gpt-6-sol"
  | "gpt-6-luna"
  | "gpt-5-6-sol"
  | "gpt-5-6-terra"
  | "gpt-5-6-luna";

export type ModelSelectionId = Exclude<WebchatLargeModelSelectionId, "auto">;

export interface WebchatLargeModelSelection {
  id: ModelSelectionId;
  providerId: "openai" | "anthropic";
  model: string;
}

export const WEBCHAT_LARGE_MODEL_SELECTIONS: Record<ModelSelectionId, WebchatLargeModelSelection> =
  {
    "claude-opus": {
      id: "claude-opus",
      providerId: "anthropic",
      model: "claude-opus-4-8[1m]",
    },
    "claude-opus-5-5": {
      id: "claude-opus-5-5",
      providerId: "anthropic",
      model: "claude-opus-5-5[1m]",
    },
    "claude-opus-5": {
      id: "claude-opus-5",
      providerId: "anthropic",
      model: "claude-opus-5[1m]",
    },
    "claude-opus-4-6": {
      id: "claude-opus-4-6",
      providerId: "anthropic",
      model: "claude-opus-4-6[1m]",
    },
    "claude-sonnet": {
      id: "claude-sonnet",
      providerId: "anthropic",
      model: "claude-sonnet-5-5",
    },
    "claude-haiku": {
      id: "claude-haiku",
      providerId: "anthropic",
      model: "claude-haiku-5-5",
    },
    "claude-fable": {
      id: "claude-fable",
      providerId: "anthropic",
      model: "claude-fable-5-1[1m]",
    },
    "gpt-6-astra": {
      id: "gpt-6-astra",
      providerId: "openai",
      model: "gpt-6-astra",
    },
    "gpt-6-1-sol": {
      id: "gpt-6-1-sol",
      providerId: "openai",
      model: "gpt-6.1-sol",
    },
    "gpt-6-sol": {
      id: "gpt-6-sol",
      providerId: "openai",
      model: "gpt-6-sol",
    },
    "gpt-6-luna": {
      id: "gpt-6-luna",
      providerId: "openai",
      model: "gpt-6-luna",
    },
    "gpt-5-6-sol": {
      id: "gpt-5-6-sol",
      providerId: "openai",
      model: "gpt-5.6-sol",
    },
    "gpt-5-6-terra": {
      id: "gpt-5-6-terra",
      providerId: "openai",
      model: "gpt-5.6-terra",
    },
    "gpt-5-6-luna": {
      id: "gpt-5-6-luna",
      providerId: "openai",
      model: "gpt-5.6-luna",
    },
  };
