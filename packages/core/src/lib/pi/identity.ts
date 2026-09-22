const QUALIFIED_MODEL_SEPARATOR = "/";

export interface PiModelIdentity {
  upstreamProvider: string;
  modelId: string;
}

export class InvalidPiModelIdentityError extends Error {
  constructor() {
    super("The qualified Pi model identity is invalid.");
    this.name = "InvalidPiModelIdentityError";
  }
}

/** Encode both components so provider/model pairs remain reversible and collision-free. */
export function qualifyPiModelId(upstreamProvider: string, modelId: string): string {
  if (!upstreamProvider || !modelId) throw new InvalidPiModelIdentityError();
  return `${encodeURIComponent(upstreamProvider)}${QUALIFIED_MODEL_SEPARATOR}${encodeURIComponent(modelId)}`;
}

/** Accept only the canonical representation emitted by {@link qualifyPiModelId}. */
export function parseQualifiedPiModelId(qualifiedModelId: string): PiModelIdentity {
  const separator = qualifiedModelId.indexOf(QUALIFIED_MODEL_SEPARATOR);
  if (separator <= 0 || separator === qualifiedModelId.length - 1) {
    throw new InvalidPiModelIdentityError();
  }

  try {
    const upstreamProvider = decodeURIComponent(qualifiedModelId.slice(0, separator));
    const modelId = decodeURIComponent(qualifiedModelId.slice(separator + 1));
    if (qualifyPiModelId(upstreamProvider, modelId) !== qualifiedModelId) {
      throw new InvalidPiModelIdentityError();
    }
    return { upstreamProvider, modelId };
  } catch (error) {
    if (error instanceof InvalidPiModelIdentityError) throw error;
    throw new InvalidPiModelIdentityError();
  }
}
