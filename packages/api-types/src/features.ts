// Features Rome hides from the guardian as a whole, and whether each is shown.
// Core and the dashboard both read the visibility below.

/** Each id is the name the feature's usage is counted under. */
export const GATED_FEATURES = ["people", "inbox"] as const;

export type GatedFeature = (typeof GATED_FEATURES)[number];

/** First-party apps that are a gated feature, by app id. Such an app is left
 *  out of every list of apps while its feature is hidden. */
export const APP_FEATURES: Readonly<Record<string, GatedFeature>> = { inbox: "inbox" };

/** The gated feature an app is, if any. Reads only the map's own keys, so an
 *  app id such as `constructor` is no feature. */
export function appFeature(appId: string): GatedFeature | undefined {
  return Object.hasOwn(APP_FEATURES, appId) ? APP_FEATURES[appId] : undefined;
}

/** Whether each gated feature is shown. */
export type FeatureVisibility = Record<GatedFeature, boolean>;

/** Whether each gated feature is shown in this release. */
export const FEATURE_VISIBILITY: Readonly<FeatureVisibility> = {
  people: false,
  inbox: false,
};

/** Whether `feature` is shown in this release. */
export function isFeatureShown(feature: GatedFeature): boolean {
  return FEATURE_VISIBILITY[feature];
}
