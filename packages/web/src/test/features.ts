import { type FeaturesResponse, GATED_FEATURES } from "@rome/api-types/features";

/** Where the dashboard asks which gated features are shown. */
export const FEATURES_URL = "/api/features";

/** Core's answer to `GET /api/features` on an instance that shows every gated
 *  feature, for tests whose fetch stub answers every URL itself. */
export function allFeaturesShown(): Response {
  const features = Object.fromEntries(GATED_FEATURES.map((feature) => [feature, true]));
  return Response.json({ features } as FeaturesResponse);
}
