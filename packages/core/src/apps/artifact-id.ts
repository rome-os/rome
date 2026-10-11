import { isValidAppId } from "@rome-os/app-runtime/packaging";
export { isCoreMainAgentId } from "@rome-os/app-runtime";

export type NamespacedArtifactKind = "agent" | "action" | "skill";
export type ArtifactId = string & { readonly __artifactId: unique symbol };

export interface LegacyArtifactBindings {
  version: 1;
  agent: Record<string, ArtifactId>;
  action: Record<string, ArtifactId>;
  skill: Record<string, ArtifactId>;
}

export interface ArtifactIdentityContext {
  legacyBindings: LegacyArtifactBindings;
}

export const ARTIFACT_LEGACY_BINDINGS_SETTING = "artifactLegacyBindingsV1";

export function createEmptyLegacyArtifactBindings(): LegacyArtifactBindings {
  return { version: 1, agent: {}, action: {}, skill: {} };
}

export function parseLegacyArtifactBindings(value: unknown): LegacyArtifactBindings {
  const parsed = createEmptyLegacyArtifactBindings();
  if (!value || typeof value !== "object") return parsed;
  const input = value as Record<string, unknown>;
  if (input.version !== 1) return parsed;

  for (const kind of ["agent", "action", "skill"] as const) {
    const entries = input[kind];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [legacyName, artifactId] of Object.entries(entries)) {
      if (!legacyName || legacyName.includes(":") || typeof artifactId !== "string") continue;
      if (!isCanonicalArtifactId(artifactId)) continue;
      parsed[kind][legacyName] = artifactId;
    }
  }
  return parsed;
}

export function formatArtifactId(appId: string, localName: string): ArtifactId {
  if (appId !== "core" && !isValidAppId(appId)) {
    throw new Error(`Invalid artifact namespace ${JSON.stringify(appId)}`);
  }
  if (!localName || localName.includes(":")) {
    throw new Error(
      `Invalid artifact local name ${JSON.stringify(localName)}: names must not contain ":"`,
    );
  }
  return `${appId}:${localName}` as ArtifactId;
}

export function isCanonicalArtifactId(value: string): value is ArtifactId {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator !== value.lastIndexOf(":")) return false;
  const namespace = value.slice(0, separator);
  const localName = value.slice(separator + 1);
  return (namespace === "core" || isValidAppId(namespace)) && localName.length > 0;
}

export function artifactLocalName(id: string): string {
  const separator = id.indexOf(":");
  return separator < 0 ? id : id.slice(separator + 1);
}

export function claimLegacyArtifactName(
  bindings: LegacyArtifactBindings,
  kind: NamespacedArtifactKind,
  legacyName: string,
  artifactId: ArtifactId,
): { claimed: boolean; conflict?: ArtifactId } {
  if (!legacyName || legacyName.includes(":")) return { claimed: false };
  const existing = bindings[kind][legacyName];
  if (existing === undefined) {
    bindings[kind][legacyName] = artifactId;
    return { claimed: true };
  }
  if (existing === artifactId) return { claimed: false };
  return { claimed: false, conflict: existing };
}

export function claimLegacyArtifactNames(
  bindings: LegacyArtifactBindings,
  kind: NamespacedArtifactKind,
  legacyNames: readonly string[],
  artifactId: ArtifactId,
): { claimed: boolean; conflicts: Array<{ legacyName: string; artifactId: ArtifactId }> } {
  const names = [...new Set(legacyNames.filter((name) => name && !name.includes(":")))];
  const conflicts = names.flatMap((legacyName) => {
    const existing = bindings[kind][legacyName];
    return existing !== undefined && existing !== artifactId
      ? [{ legacyName, artifactId: existing }]
      : [];
  });
  if (conflicts.length > 0) return { claimed: false, conflicts };

  let claimed = false;
  for (const legacyName of names) {
    claimed = claimLegacyArtifactName(bindings, kind, legacyName, artifactId).claimed || claimed;
  }
  return { claimed, conflicts: [] };
}

/**
 * The only compatibility boundary for artifact references.
 *
 * New IDs are already qualified. A bare legacy name is resolved only through
 * the stable binding map; callers must never scan a live registry and guess an
 * owner.
 */
export function resolveArtifactId(input: {
  kind: NamespacedArtifactKind;
  value: string;
  legacyBindings: Readonly<LegacyArtifactBindings>;
}): ArtifactId {
  const value = input.value.trim();
  if (!value) throw new Error(`Empty ${input.kind} reference`);

  if (value.includes(":")) {
    if (!isCanonicalArtifactId(value)) {
      throw new Error(`Invalid ${input.kind} artifact ID ${JSON.stringify(value)}`);
    }
    return value;
  }

  const bound = input.legacyBindings[input.kind][value];
  if (!bound) {
    throw new Error(`Unknown legacy ${input.kind} name ${JSON.stringify(value)}`);
  }
  return bound;
}
