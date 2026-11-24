// Routes only the guardian may call, mounted on the "guardian-only-route"
// stand-in product. Each has its own guard, so the stand-in keeps refusing a
// teammate whatever the product does with its guardian-only guards.

import { Hono } from "hono";
import type { Feature } from "../../api/deps.js";
import { currentSessionActor } from "../../access/session-actor.js";

export const STAND_IN_GUARDIAN_ONLY_ROUTE = "GET /api/team-verifier/guardian-only";
/** Validates its body before the guard. `bodies.ts` gives it a valid body. */
export const STAND_IN_GUARDIAN_ONLY_WRITE = "POST /api/team-verifier/guardian-only-write";
/** Validates its body before the guard, and has no valid body in `bodies.ts`,
 *  so both callers get the same 400. */
export const STAND_IN_VALIDATES_FIRST = "POST /api/team-verifier/validates-first";

const pathOf = (route: string) => route.slice(route.indexOf(" /api") + " /api".length);

export function guardianOnlyFeature(): Feature {
  const routes = new Hono();
  const isGuardian = async () => (await currentSessionActor())?.kind === "guardian";
  routes.get(pathOf(STAND_IN_GUARDIAN_ONLY_ROUTE), async (c) => {
    if (!(await isGuardian())) return c.json({ error: "guardian only" }, 403);
    return c.json({ ok: true });
  });
  for (const route of [STAND_IN_GUARDIAN_ONLY_WRITE, STAND_IN_VALIDATES_FIRST]) {
    routes.post(pathOf(route), async (c) => {
      const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
      if (body?.confirm !== true) return c.json({ error: "confirm must be true" }, 400);
      if (!(await isGuardian())) return c.json({ error: "guardian only" }, 403);
      return c.json({ ok: true });
    });
  }
  return { routes, actions: [] };
}
