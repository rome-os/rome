import { Hono } from "hono";
import type { ApiDeps } from "../../../deps.js";
import { accountDecisionRoutes } from "./account-decisions.js";
import { accountsRoutes } from "./accounts.js";
import { peopleRoutes } from "./people.js";

// The phone book's routes, mounted as one: leaving the phone book out is
// skipping this mount.

export function phoneBookRoutes(deps: ApiDeps): Hono {
  return new Hono()
    .route("/", peopleRoutes(deps))
    .route("/", accountsRoutes(deps))
    .route("/", accountDecisionRoutes(deps));
}
