// A signed-in person asks for a code, which they then send to Rome in a direct
// message from the account they want added. Vocabulary:
// docs/domains/identity.md#account-code.

import { Hono } from "hono";
import { createAccess } from "../../access/access.js";
import { currentSessionActor, type SessionActor } from "../../access/session-actor.js";
import { accountCodeContext, accountCodeIssued } from "../../identity/application/account-codes.js";
import { createIdentity, ROME_CLOUD_EMAIL_PLATFORM } from "../../identity/identity.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

/** `POST /account-codes`, for the guardian and members alike. Answers
 *  `{ code, expiresAt }`. `now` is the clock codes expire by. */
export function accountCodesRoutes(
  deps: Pick<ApiDeps, "db">,
  now: () => Date = () => new Date(),
): Hono {
  const app = new Hono();
  const codes = accountCodeContext(deps.db, now);
  const identity = createIdentity(deps.db);
  const access = createAccess(deps.db);

  // The person a signed-in session is. The guardian's seat, by Rome Cloud or
  // the local password, is the person with the guardian's role. A visitor is
  // the one who holds the session's email as a Rome Cloud sign-in's account.
  async function personOf(actor: SessionActor): Promise<string | null> {
    if (actor.kind === "anonymous") return null;
    if (actor.kind === "guardian") {
      return (await access.members()).find((m) => m.role === "guardian")?.personId ?? null;
    }
    const person = await identity.personOf({
      platform: ROME_CLOUD_EMAIL_PLATFORM,
      accountId: actor.email,
    });
    return person?.id ?? null;
  }

  app.post("/account-codes", async (c) => {
    const actor = await currentSessionActor();
    if (!actor || actor.kind === "anonymous") return c.json({ error: "Sign in first" }, 401);
    // Only the person's own browser asks: not an agent's shell acting as the
    // guardian's seat, and not another site posting with their cookie.
    if (actor.kind === "guardian" && actor.via !== "cookie") {
      return c.json({ error: "Ask from a signed-in browser" }, 403);
    }
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const personId = await personOf(actor);
    if (!personId) return c.json({ error: "This sign-in belongs to no person" }, 403);
    const { code, expiresAt } = await accountCodeIssued(codes, personId);
    return c.json({ code, expiresAt: expiresAt.toISOString() });
  });

  return app;
}
