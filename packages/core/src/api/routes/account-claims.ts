// The sign-in link's page asks what a claim is for, and the signed-in person
// confirms it to make the account theirs. Vocabulary:
// docs/domains/identity.md#claim.

import { Hono } from "hono";
import { createAccess } from "../../access/access.js";
import { currentSessionActor, type SessionActor } from "../../access/session-actor.js";
import {
  accountClaimConfirmed,
  accountClaimOf,
  ClaimExpiredError,
  claimContext,
  ClaimUsedError,
  UnknownClaimError,
} from "../../identity/application/account-claims.js";
import {
  AccountTakenError,
  createIdentity,
  ROME_CLOUD_EMAIL_PLATFORM,
} from "../../identity/identity.js";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import type { ApiDeps } from "../deps.js";

/** `GET /account-claims/:token` and `POST /account-claims/:token/confirm`,
 *  for the guardian and members alike. `now` is the clock claims expire by. */
export function accountClaimsRoutes(
  deps: Pick<ApiDeps, "db">,
  now: () => Date = () => new Date(),
): Hono {
  const app = new Hono();
  const claims = claimContext(deps.db, now);
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

  app.get("/account-claims/:token", async (c) => {
    const actor = await currentSessionActor();
    if (!actor || actor.kind === "anonymous") return c.json({ error: "Sign in first" }, 401);
    const claim = await accountClaimOf(claims, c.req.param("token"));
    if (!claim) return c.json({ error: "claim_not_found" }, 404);
    return c.json({
      platform: claim.account.platform,
      account: claim.account.accountId,
      label: claim.label,
      expiresAt: claim.expiresAt.toISOString(),
    });
  });

  app.post("/account-claims/:token/confirm", async (c) => {
    const actor = await currentSessionActor();
    if (!actor || actor.kind === "anonymous") return c.json({ error: "Sign in first" }, 401);
    // Only the person's own browser confirms: not an agent's shell acting as
    // the guardian's seat, and not another site posting with their cookie.
    if (actor.kind === "guardian" && actor.via !== "cookie") {
      return c.json({ error: "Confirm from a signed-in browser" }, 403);
    }
    if (!isSameOriginMutationRequest(c.req.raw)) {
      return c.json({ error: "Cross-site requests are not allowed." }, 403);
    }
    const personId = await personOf(actor);
    if (!personId) return c.json({ error: "This sign-in belongs to no person" }, 403);
    try {
      const { account, label } = await accountClaimConfirmed(
        claims,
        c.req.param("token"),
        personId,
      );
      return c.json({ platform: account.platform, account: account.accountId, label });
    } catch (err) {
      if (
        err instanceof UnknownClaimError ||
        err instanceof ClaimExpiredError ||
        err instanceof ClaimUsedError
      ) {
        return c.json({ error: "claim_not_found" }, 404);
      }
      if (err instanceof AccountTakenError) return c.json({ error: "account_taken" }, 409);
      throw err;
    }
  });

  return app;
}
