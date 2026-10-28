import type { GrantValue } from "../connections/grant.js";

// The mapping lives in `@rome/api-types/platform`, where the dashboard reads it
// too. This re-export keeps imports of this path compiling.
export { platformOf } from "@rome/api-types/platform";

/** The domain a grant's profile names, which `platformOf` reads for a Feishu
 *  app, or undefined when the profile names none. */
export function domainOf(
  profile: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const domain = profile?.domain;
  return typeof domain === "string" ? domain : undefined;
}

/** The domain a Connection's grant names. A grant from before profiles names
 *  it only in its inline material, so that is read when the profile names
 *  none, the way migration 0083 reads it. */
export function domainOfGrant(grant: GrantValue | null): string | undefined {
  const material = grant?.credential?.material;
  const domain =
    domainOf(grant?.profile) ?? (material?.kind === "inline" ? material.record.domain : undefined);
  return typeof domain === "string" ? domain : undefined;
}
