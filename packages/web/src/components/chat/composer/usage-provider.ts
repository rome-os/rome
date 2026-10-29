import {
  autoModelProvider,
  type AIToolsStatus,
  type AIToolProviderId,
} from "@rome/api-types/ai-tools";
import { WEBCHAT_LARGE_MODEL_SELECTIONS } from "@rome/api-types/model-selection";

/** An explicit pick overrides the last successful model pin. Auto keeps an existing pin. */
export function usageProvider(
  selection: string,
  pinnedModel: string | null | undefined,
  status: AIToolsStatus,
): AIToolProviderId | null {
  if (selection !== "auto") {
    const picked =
      WEBCHAT_LARGE_MODEL_SELECTIONS[selection as keyof typeof WEBCHAT_LARGE_MODEL_SELECTIONS];
    return picked?.providerId ?? null;
  }
  if (pinnedModel) {
    if (pinnedModel.startsWith("claude-")) return "anthropic";
    if (pinnedModel.startsWith("gpt-")) return "openai";
    return null;
  }
  return autoModelProvider(status.codex ?? null, status.claude ?? null);
}
