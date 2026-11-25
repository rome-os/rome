import {
  MODEL_CATALOG,
  isModelSelectionId,
  canonicalModelSelection,
  type ModelSelectionId,
} from "@rome/api-types/models";
import type { ProviderId } from "./model-port.js";

export { isModelSelectionId, canonicalModelSelection, type ModelSelectionId };
export interface ModelSelection {
  id: ModelSelectionId;
  providerId: ProviderId;
  model: string;
}

export const MODEL_SELECTIONS = Object.fromEntries(
  MODEL_CATALOG.map(({ id, providerId, modelId }) => [id, { id, providerId, model: modelId }]),
) as Record<ModelSelectionId, ModelSelection>;

export const CODEX_SOL_MODEL = MODEL_SELECTIONS["openai/gpt-6.1-sol"].model;
export const CODEX_LUNA_MODEL = MODEL_SELECTIONS["openai/gpt-6-luna"].model;
export const CODEX_TERRA_MODEL = MODEL_SELECTIONS["openai/gpt-5.6-terra"].model;
