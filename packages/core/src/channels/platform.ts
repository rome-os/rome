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
