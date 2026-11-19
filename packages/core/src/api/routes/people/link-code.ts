import { Hono } from "hono";
import type { LinkCodeResponse } from "@rome/api-types/people";
import { isSameOriginMutationRequest } from "../../../lib/mutation-origin.js";
import { currentSessionActor } from "../../../access/session-actor.js";
import type { ApiDeps } from "../../deps.js";

// The link code's route: the guardian asks for a code to send Rome from an
// account, which proves the account is theirs. Redeeming it is
// `src/people/link-code/`.

export function linkCodeRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // A redeemed code makes its sender the guardian, so only the guardian may
  // see one, and only from the dashboard itself.
  app.post("/people/link-code", async (c) => {
    if ((await currentSessionActor())?.kind !== "guardian")
      return c.json({ error: "Guardian authentication required" }, 403);
    if (!isSameOriginMutationRequest(c.req.raw))
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    c.header("Cache-Control", "no-store");
    return c.json(deps.guardianLinkCodes.issue() satisfies LinkCodeResponse, 201);
  });

  return app;
}
