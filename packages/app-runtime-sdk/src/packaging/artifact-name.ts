import { z } from "zod";
import { isValidAppId } from "./app-id.js";

/** `:` separates an artifact namespace from its app-local name. */
export const ARTIFACT_NAMESPACE_SEPARATOR = ":";
export const ARTIFACT_LOCAL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const ArtifactLocalNameSchema = z
  .string()
  .min(1)
  .refine((name) => !name.includes(ARTIFACT_NAMESPACE_SEPARATOR), {
    message: 'must not contain ":" because it is reserved for artifact namespaces',
  });

export const ArtifactLocalNameV2Schema = ArtifactLocalNameSchema.refine(
  (name) => ARTIFACT_LOCAL_NAME_PATTERN.test(name),
  "must start with a lowercase letter and contain only lowercase letters, numbers, underscores, or hyphens (max 64 chars)",
);

export function isValidArtifactReference(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator !== value.lastIndexOf(":")) return false;
  const namespace = value.slice(0, separator);
  const localName = value.slice(separator + 1);
  return (
    (namespace === "core" || isValidAppId(namespace)) && ARTIFACT_LOCAL_NAME_PATTERN.test(localName)
  );
}
