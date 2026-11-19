import { Hono } from "hono";
import type { FeaturesResponse } from "@rome/api-types/features";
import { resolveFeatureVisibility } from "../../instance/feature-visibility.js";

export function featuresRoutes(): Hono {
  const app = new Hono();
  app.get("/features", async (c) => {
    const response: FeaturesResponse = { features: await resolveFeatureVisibility() };
    return c.json(response);
  });
  return app;
}
