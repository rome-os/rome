import { type GatedFeature, isFeatureShown } from "@rome/api-types/features";

/** Whether something that belongs to `feature` is shown. Something that
 *  belongs to no feature always is. */
export function isShown(feature: GatedFeature | undefined): boolean {
  return feature === undefined || isFeatureShown(feature);
}
