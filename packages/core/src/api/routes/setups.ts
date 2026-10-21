// Connection conferral HTTP surface. Vocabulary: docs/domains/connections.md.
//
// Four routes for EVERY service's connect setup (channels + brokered OAuth
// alike); per-service knowledge lives in the integration descriptor's
// `setup`, never here:
//   POST /api/connections/:id/grants/:name/setup  — start or re-attach
//   GET  /api/setups/:cid                          — poll state
//   POST /api/setups/:cid/input                    — feed answers
//   POST /api/setups/:cid/cancel                   — cancel
//
// `:id` addresses the connection to confer. For a service the guardian has
// never connected there is no ledger row yet (the terminal conferral mints it),
// so `:id` may instead be a bare service name — an offerable placeholder. A
// start naming the service with `another: true` connects a new account of a
// service that offers several, minted the same way. Either way the setup is
// keyed by (service, grant); the manager enforces one active setup per grant
// and re-attaches a duplicate start.

import { Hono, type Context } from "hono";
import { isSameOriginMutationRequest } from "../../lib/mutation-origin.js";
import { NoSetupError, type SetupTarget } from "../../connections/setup/manager.js";
import type { ConnectionRegistry } from "../../connections/index.js";
import { isUnconnectedAccount } from "../../connections/unconnected-accounts.js";
import type { ApiDeps } from "../deps.js";
import { createLogger } from "../../logger.js";
import { requireSetupManager, requireConnectionRegistry } from "../helpers.js";

const log = createLogger("setups");

/** Resolve what a setup start addresses. `:id` is either a live connection id
 *  (carry the id AND its service so the terminal write imports into THAT
 *  connection) or, for a never-connected service, the bare service name — valid
 *  only when a descriptor is registered for it (placeholder; the write mints the
 *  row). With `another`, `:id` must name a service that offers several
 *  accounts, and the write mints a new one. Null when none of these. */
function resolveTarget(
  registry: ConnectionRegistry,
  id: string,
  another: boolean,
): SetupTarget | null {
  if (another) {
    return registry.getDescriptor(id)?.severalAccounts === true
      ? { service: id, another: true }
      : null;
  }
  const conn = registry.all().find((c) => c.id === id);
  if (conn) return { service: conn.service, connectionId: conn.id };
  return registry.isRegistered(id) ? { service: id } : null;
}

/** Remove `connectionId` when it is an account a failed removal left behind,
 *  so no setup connects into its old channel. Answers "kept" for an account
 *  still connected, "gone" once it is removed (now, or by a disconnect that
 *  ran first), and "stuck" when the removal fails again, which leaves it for
 *  the boot pass. */
async function removeLeftoverAccount(
  registry: ConnectionRegistry,
  service: string,
  connectionId: string,
  grant: string,
): Promise<"kept" | "gone" | "stuck"> {
  return registry.withGrantSection(service, grant, async () => {
    const conn = registry.all().find((held) => held.id === connectionId);
    if (!conn) return "gone";
    if (!(await isUnconnectedAccount(registry, conn))) return "kept";
    try {
      await registry.remove(connectionId);
    } catch (error) {
      log.warn("could not remove a disconnected account before its setup", { connectionId, error });
      return "stuck";
    }
    return "gone";
  });
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
    const registry = requireConnectionRegistry(deps);
    const manager = requireSetupManager(deps);
    const body = await c.req
      .json<{ force?: unknown; another?: unknown }>()
      .catch(() => ({}) as { force?: unknown; another?: unknown });
    const force = body.force === true;
    const another = body.another === true;
    const id = c.req.param("id");
    const target = resolveTarget(registry, id, another);
    if (!target) {
      return another
        ? c.json({ error: `"${id}" does not offer another account.` }, 400)
        : c.json({ error: "Unknown connection." }, 404);
    }
    const grant = c.req.param("name");
    // Checked before anything below touches the account, so a start for a
    // grant with no setup changes nothing.
    if (!registry.getDescriptor(target.service)?.auth[grant]?.setup) {
      return c.json({ error: "No conferral setup for this grant." }, 404);
    }
    // An account that connects again starts fresh, so the card of a
    // disconnected account offers no setup into it. Its card goes on the next
    // refresh, and the service's own Connect starts the new account.
    if (target.connectionId) {
      const leftover = await removeLeftoverAccount(
        registry,
        target.service,
        target.connectionId,
        grant,
      );
      if (leftover === "gone") {
        return c.json(
          { error: "This account was disconnected. Connect it again from its service." },
          409,
        );
      }
      if (leftover === "stuck") {
        return c.json(
          {
            error:
              "Rome could not clear this disconnected account. Restart Rome, then connect it again.",
          },
          409,
        );
      }
    }
    try {
      const started = await manager.start(target, grant, { force });
      c.header("Cache-Control", "no-store");
      return c.json(started);
    } catch (err) {
      if (err instanceof NoSetupError) {
        return c.json({ error: "No conferral setup for this grant." }, 404);
      }
      throw err;
    }
  });

  // Poll a setup's current state.
  app.get("/setups/:cid", (c) => {
    const manager = requireSetupManager(deps);
    const state = manager.state(c.req.param("cid"));
    if (!state) return c.json({ error: "Unknown setup." }, 404);
    c.header("Cache-Control", "no-store");
    return c.json({ state });
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
    return c.json(outcome, outcome.accepted ? 200 : 409);
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
      { matched: true, cid: resumed.cid, service: resumed.service, ...outcome },
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
    return c.json({ state });
  });

  return app;
}
