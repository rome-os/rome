import type { GatedFeature } from "@rome/api-types/features";

/** The features a test hides. A test file that stands this module in for
 *  `@/lib/features` shows every other feature, whatever this release shows:
 *
 *    rs.mock("@/lib/features", () => ({ isShown: (f) => isShownInTest(f) }));
 */
export const hiddenFeatures = new Set<GatedFeature>();

export function isShownInTest(feature: GatedFeature | undefined): boolean {
  return feature === undefined || !hiddenFeatures.has(feature);
}
