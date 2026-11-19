// Features Rome can hide from the guardian as a whole, and whether each is
// shown on this instance (`GET /api/features`).

/** Each id is the feature's gate name, and the name its usage is counted under.
 *  A feature on this list is hidden unless its gate is on. */
export const GATED_FEATURES = ["people", "envoys", "inbox"] as const;

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

export interface FeaturesResponse {
  features: FeatureVisibility;
}
