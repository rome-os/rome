import { isCoreMainAgentId, isCanonicalArtifactId } from "../apps/artifact-id.js";

export interface AutomatedSource {
  type: "agent" | "app" | "routine" | null;
  id: string | null;
  /** Absent only for runtime.post agent accounts, whose stored actor decides. */
  onBehalf?: boolean;
}

/** A one-bit guardian-delegation flag precedes the initiator. Double colons keep the tag distinct from canonical agent ids. */
export function automatedSenderId(initiator: string, actorKind?: unknown): string {
  const source = parseSource(initiator);
  return `automated::${speaksForGuardian(source, actorKind) ? "1" : "0"}::${initiator}`;
}

/** Visitor delegation is not supported: it must not borrow the guardian's identity. */
export function speaksForGuardian(source: AutomatedSource, actorKind: unknown): boolean {
  return (
    actorKind === "guardian" &&
    (source.type === "app" ||
      (source.type === "agent" &&
        source.id !== null &&
        (isCoreMainAgentId(source.id) || source.id === "core:concierge")))
  );
}

/** Untagged canonical agent ids are the existing runtime.post account encoding. */
export function automatedSource(senderId: string | null | undefined): AutomatedSource | null {
  if (!senderId) return null;
  if (!senderId.startsWith("automated::")) {
    return isCanonicalArtifactId(senderId) ? { type: "agent", id: senderId } : null;
  }
  const tagged = senderId.slice("automated::".length);
  return { ...parseSource(tagged.slice(3)), onBehalf: tagged.startsWith("1::") };
}

function parseSource(source: string): AutomatedSource {
  for (const type of ["agent", "app", "routine"] as const) {
    const prefix = `${type}:`;
    if (source.startsWith(prefix) && source.length > prefix.length) {
      return { type, id: source.slice(prefix.length) };
    }
  }
  return { type: null, id: null };
}

/** A source name stays on one prompt line and cannot close a context block. */
export function promptSafeSourceName(name: string): string {
  return name
    .replace(/[^\p{L}\p{N} ._:@/()-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
