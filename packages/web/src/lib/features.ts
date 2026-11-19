import { type GatedFeature, isFeatureShown } from "@rome/api-types/features";

// The mock build shows every feature, so its fixtures and the browser suites
// that run on it reach every page. Only the mock entry sets this.
let showAll = false;

/** Shows every feature, whatever this release hides. Called by the mock entry
 *  before the dashboard renders. */
export function showAllFeaturesInMock(): void {
  showAll = true;
}

/** Whether something that belongs to `feature` is shown. Something that
 *  belongs to no feature always is. */
export function isShown(feature: GatedFeature | undefined): boolean {
  return feature === undefined || showAll || isFeatureShown(feature);
}
