import type { MiddlewareHandler } from "hono";
import {
  FEATURE_VISIBILITY,
  type FeatureVisibility,
  type GatedFeature,
} from "@rome/api-types/features";

/** The API routes only a gated feature's pages call, by path under `/api`.
 *  The first match names the route's feature. */
const GATED_ROUTES: ReadonlyArray<{ feature: GatedFeature; path: RegExp }> = [
  // Linking an agent to a connected account is Envoys, though it sits under
  // the accounts People lists.
  { feature: "envoys", path: /^\/connected-accounts(\/|$)/ },
  { feature: "envoys", path: /^\/accounts\/[^/]+\/agent$/ },
  { feature: "people", path: /^\/people(\/|$)/ },
  { feature: "people", path: /^\/accounts(\/|$)/ },
  { feature: "inbox", path: /^\/sentinel-log(\/|$)/ },
];

/** The gated feature a path under `/api` belongs to, if any. */
export function gatedFeatureOf(apiPath: string): GatedFeature | undefined {
  return GATED_ROUTES.find((route) => route.path.test(apiPath))?.feature;
}

/**
 * Answers 404 for a hidden feature's API routes, as if they did not exist, so
 * no client reaches a feature the dashboard hides. Every other request passes
 * untouched.
 */
export function hideGatedFeatureRoutes(
  visibility: Readonly<FeatureVisibility> = FEATURE_VISIBILITY,
): MiddlewareHandler {
  return async (c, next) => {
    const feature = gatedFeatureOf(c.req.path.replace(/^\/api(?=\/|$)/, ""));
    if (feature !== undefined && !visibility[feature]) {
      return c.json({ error: "Not found" }, 404);
    }
    await next();
  };
}
