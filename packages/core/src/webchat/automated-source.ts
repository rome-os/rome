import { isCanonicalArtifactId } from "../apps/artifact-id.js";

export interface AutomatedSource {
  type: "agent" | "app" | "routine" | null;
  id: string | null;
}

/** Two colons keep tagged sources distinct from runtime.post's canonical agent ids, including an app named automated. */
export function automatedSenderId(initiator: string): string {
  return `automated::${initiator}`;
}

/** Untagged canonical agent ids are the existing runtime.post account encoding. */
export function automatedSource(senderId: string | null | undefined): AutomatedSource | null {
  if (!senderId) return null;
  if (!senderId.startsWith("automated::")) {
    return isCanonicalArtifactId(senderId) ? { type: "agent", id: senderId } : null;
  }
  const source = senderId.slice("automated::".length);
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
