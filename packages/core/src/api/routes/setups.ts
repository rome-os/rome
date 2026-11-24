// Connection grant HTTP surface. Vocabulary: docs/domains/connections.md.
//
// Four routes for EVERY connection kind's connect setup (channels + brokered OAuth
// alike); per-kind knowledge lives in the integration descriptor's
// `setup`, never here:
//   POST /api/connections/:id/grants/:name/setup  — start or re-attach
//   GET  /api/setups/:cid                          — poll state
//   POST /api/setups/:cid/input                    — feed answers
//   POST /api/setups/:cid/cancel                   — cancel
//
// `:id` addresses the connection to grant. For a connection kind the guardian has
// never connected there is no ledger row yet (the terminal grant mints it),
// so `:id` may instead be a bare connection kind — an offerable placeholder. A
// start naming the connection kind with `another: true` connects a new account of a
// connection kind that offers several, minted the same way. Either way the setup is
// keyed by (connection kind, grant); the manager enforces one active setup per grant
// and re-attaches a duplicate start.

import { Hono, type Context } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { startConnectionSetup } from "../../connections/setup/start.js";
import type { ApiDeps } from "../deps.js";
import { requireSetupManager, requireConnectionRegistry } from "../helpers.js";
import type { SetupState } from "../../connections/setup/types.js";

/** The state as the wire carries it. A finished setup also carries its grant
 *  under `conferral`, the field's old name, because a dashboard tab loaded
 *  before an upgrade still reads it. Remove the alias once those tabs are gone. */
function wireState(state: SetupState) {
  return state.status === "done" ? { ...state, conferral: state.grant } : state;
}

function crossOriginBlocked(c: Context): Response | null {
  if (!isSameOriginMutationRequest(c.req.raw)) {
    return c.json({ error: "Cross-site requests are not allowed." }, 403);
  }
  return null;
}

export function setupsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // Start or re-attach a setup for one grant.
  app.post("/connections/:id/grants/:name/setup", async (c) => {
    const blocked = crossOriginBlocked(c);
    if (blocked) return blocked;
    const body = await c.req
      .json<{ force?: unknown; another?: unknown }>()
      .catch(() => ({}) as { force?: unknown; another?: unknown });
    const outcome = await startConnectionSetup(
      { registry: requireConnectionRegistry(deps), manager: requireSetupManager(deps) },
      {
        idOrKind: c.req.param("id"),
        grant: c.req.param("name"),
        force: body.force === true,
        another: body.another === true,
      },
    );
    if (outcome.status === "refused") return c.json({ error: outcome.error }, outcome.code);
    c.header("Cache-Control", "no-store");
    return c.json({ ...outcome.started, state: wireState(outcome.started.state) });
  });

  // Poll a setup's current state.
  app.get("/setups/:cid", (c) => {
    const manager = requireSetupManager(deps);
    const state = manager.state(c.req.param("cid"));
    if (!state) return c.json({ error: "Unknown setup." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ state: wireState(state) });
  });

  // Feed the guardian's answers to a setup awaiting input.
  app.post("/setups/:cid/input", async (c) => {
    const blocked = crossOriginBlocked(c);
    if (blocked) return blocked;
    const manager = requireSetupManager(deps);
    const body = await c.req
      .json<{ answers?: unknown }>()
      .catch(() => ({}) as { answers?: unknown });
    const answers =
      body.answers && typeof body.answers === "object" && !Array.isArray(body.answers)
        ? (body.answers as Record<string, string>)
        : {};
    const pending = manager.provideInput(c.req.param("cid"), answers);
    if (!pending) return c.json({ error: "Unknown setup." }, 404);
    const outcome = await pending;
    c.header("Cache-Control", "no-store");
    // Idempotent against late/double delivery: a non-accepted input is a 409 so
    // the client re-polls state rather than retrying.
    return c.json({ ...outcome, state: wireState(outcome.state) }, outcome.accepted ? 200 : 409);
  });

  // Resume a setup suspended at a `redirect` verb, correlated by the OAuth
  // `state` the broker echoes on the return leg (the browser navigated fully
  // away and back, so it cannot carry the `cid`). Used by the dashboard OAuth
  // callback page.
  //
  // This is the SETUP LAYER's own return entry — the layer that unifies channels
  // + connectors into connections. It stays generic (it knows nothing about
  // OAuth): it just hands the leg to whatever setup is parked for this `state`,
  // and that setup's coroutine reaches DOWN to the OAuth redeem *primitive*
  // (`redeemRomeCloudOAuthHandoff`) to do the exchange. Deliberately NOT resumed
  // from `/oauth/redeem`: that route is the OAuth primitive wrapped for the
  // separate SIGN-IN feature (it also issues a guardian session), and entering
  // the higher setup layer through it would invert the layering — the primitive
  // reaching up into the layer above it.
  //
  // `matched:false` signals no setup owns this state (unknown/expired, or a
  // sign-in that never started a setup) — the caller falls through to the
  // sign-in redeem, which shares the same OAuth primitive. A setup that has
  // already taken a leg, or was cancelled holding one, deliberately stays a
  // match with `accepted:false`: the callback page persists in the system
  // browser now, so a reload replays the state, and reading that as sign-in
  // would import the credential by a second path — racing the redemption in
  // flight, or contradicting an explicit cancel.
  app.post("/setups/return", async (c) => {
    const blocked = crossOriginBlocked(c);
    if (blocked) return blocked;
    const manager = requireSetupManager(deps);
    const body = await c.req
      .json<{ state?: unknown; handoff?: unknown; error?: unknown }>()
      .catch(() => ({}) as { state?: unknown; handoff?: unknown; error?: unknown });
    const state = typeof body.state === "string" ? body.state.trim() : "";
    if (!state) return c.json({ matched: false, error: "state is required." }, 400);
    // The return-leg payload the suspended coroutine resolves with. `state` rides
    // along so the coroutine can redeem the broker handoff (the redeem is keyed
    // by the same state that minted the PKCE attempt).
    const payload: Record<string, string> = { state };
    if (typeof body.handoff === "string") payload.handoff = body.handoff;
    if (typeof body.error === "string") payload.error = body.error;
    const resumed = manager.provideReturnByState(state, payload);
    c.header("Cache-Control", "no-store");
    if (!resumed) return c.json({ matched: false }, 404);
    const outcome = await resumed.outcome;
    // A non-accepted resume (a race that lost the pending-redirect guard) is a
    // 409 so the caller re-polls rather than retrying.
    return c.json(
      {
        matched: true,
        cid: resumed.cid,
        connectionKind: resumed.connectionKind,
        service: resumed.connectionKind,
        ...outcome,
        state: wireState(outcome.state),
      },
      outcome.accepted ? 200 : 409,
    );
  });

  // Cancel a setup.
  app.post("/setups/:cid/cancel", async (c) => {
    const blocked = crossOriginBlocked(c);
    if (blocked) return blocked;
    const manager = requireSetupManager(deps);
    const pending = manager.cancel(c.req.param("cid"));
    if (!pending) return c.json({ error: "Unknown setup." }, 404);
    const state = await pending;
    c.header("Cache-Control", "no-store");
    return c.json({ state: wireState(state) });
  });

  return app;
}
