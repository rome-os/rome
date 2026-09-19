const PI_MODEL_SEPARATOR = "/";

export interface PiModelIdentity {
  upstreamProvider: string;
  modelId: string;
}

/**
 * Pi model ids are only unique inside their upstream provider. Keep both parts
 * in Rome's exact model pin, percent-encoding them so custom ids containing a
 * slash cannot collide with another pair.
 */
export function qualifyPiModelId(upstreamProvider: string, modelId: string): string {
  if (!upstreamProvider || !modelId) throw new Error("Pi model identity cannot be empty");
  return `${encodeURIComponent(upstreamProvider)}${PI_MODEL_SEPARATOR}${encodeURIComponent(modelId)}`;
}

export function parseQualifiedPiModelId(value: string): PiModelIdentity | null {
  const separator = value.indexOf(PI_MODEL_SEPARATOR);
  if (separator <= 0 || separator === value.length - 1) return null;
  try {
    const upstreamProvider = decodeURIComponent(value.slice(0, separator));
    const modelId = decodeURIComponent(value.slice(separator + 1));
    return upstreamProvider && modelId ? { upstreamProvider, modelId } : null;
  } catch {
    return null;
  }
}
