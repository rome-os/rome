import { MODEL_CATALOG, canonicalModelSelection, modelDisplayName } from "@rome/api-types/models";

export const LARGE_MODEL_OPTIONS = [
  { id: "auto", providerId: null, model: null },
  ...MODEL_CATALOG.map(({ id, providerId, modelId }) => ({ id, providerId, model: modelId })),
] as const;

export function modelOptionLabel(
  option: (typeof LARGE_MODEL_OPTIONS)[number],
  autoLabel: string,
): string {
  return option.model === null ? autoLabel : modelDisplayName(option.model);
}

/** Legacy drafts keep their fixed target; an unknown draft is never replaced by Auto. */
export function canonicalModelOption(value: string): string {
  return canonicalModelSelection(value) ?? value;
}
