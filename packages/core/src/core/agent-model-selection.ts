// Model selection contract: docs/concepts/sessions.md#model-pin.

import type { AgentConfig } from "../types.js";
import type { ExactModelResolutionRequest, ModelResolutionRequest } from "./model-resolver.js";
import { WEBCHAT_LARGE_MODEL_SELECTIONS, type ModelSelectionId } from "./model-selector.js";

/** Shared by session open and turn-boundary resolution. Never supplies an implicit tier. */
export function resolveAgentModelRequest(
  config: Pick<AgentConfig, "tier" | "providerId" | "modelId">,
  selectionId?: ModelSelectionId,
  sessionPin?: ExactModelResolutionRequest["exact"],
): ModelResolutionRequest {
  if (selectionId) {
    const { providerId, model } = WEBCHAT_LARGE_MODEL_SELECTIONS[selectionId];
    return { exact: { providerId, model } };
  }
  if (sessionPin) return { exact: sessionPin };
  if (config.modelId !== undefined) {
    if (!config.providerId || !config.modelId || config.tier !== undefined) {
      throw new Error("An agent modelId requires a provider and cannot be combined with tier");
    }
    return { exact: { providerId: config.providerId, model: config.modelId } };
  }
  if (!config.tier) {
    throw new Error("Agent config requires a tier or a provider with modelId");
  }
  return { tier: config.tier, providerId: config.providerId };
}
