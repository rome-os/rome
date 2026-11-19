import { Hono } from "hono";
import type { Context } from "hono";
import { dismissAccount, restoreAccount, type AccountDecision, type AccountRef } from "../index.js";
import type { ApiDeps } from "../../../api/deps.js";

// The account directory's two writes: dismiss an account, and restore one.
// What either means, when either refuses, and what each answers are
// `src/people/phone-book/account-decisions.ts`'s and the contract's
// (@rome/api-types/people). This route is the join between a path and those,
// and holds no rule of its own beyond which status each outcome is.
//
// The account is named by a pair in the path, not by a body: the pair names the
// account rather than arguing the write, so the same account is addressed the
// same way by every verb, and a retry of a POST is a retry of the same
// decision.
//
// The identifier takes the rest of the path before the verb, separators
// included, the way the unlink route takes the rest of its own. A channel mints
// its own addresses and channels are open — a Rome App brings one — so nothing
// promises those addresses avoid "/", and a plain segment would answer 404 for
// an account that exists rather than deciding it. The channel name stays one
// segment, which `accountRef` already requires of it.

export function accountDecisionRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  const answer = async (
    c: Context,
    decide: (deps: ApiDeps, ref: AccountRef) => Promise<AccountDecision>,
  ) => {
    const result = await decide(deps, {
      channel: c.req.param("channel") ?? "",
      channelUserId: c.req.param("channelUserId") ?? "",
    });
    if ("unknown" in result) return c.json({ error: "Unknown account" }, 404);
    // A refusal rather than a displacement: the body names the person who holds
    // the account, so the client can offer unlinking them by name.
    if ("conflict" in result) return c.json(result.conflict, 409);
    // The directory row, which is the row the caller already has: a client
    // re-renders what it decided without re-reading the listing to find out
    // what it now says.
    return c.json(result.account);
  };

  app.post("/accounts/:channel/:channelUserId{.+}/dismiss", (c) => answer(c, dismissAccount));
  app.post("/accounts/:channel/:channelUserId{.+}/restore", (c) => answer(c, restoreAccount));

  return app;
}
