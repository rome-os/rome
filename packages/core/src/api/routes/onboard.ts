import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { v4 as uuidv4 } from "uuid";
import { guardianAuth, persons } from "../../db/schema.js";
import { COOKIE_NAME, hashPassword, issueGuardianSession, verifySession } from "../../lib/auth.js";
import { resolveAndRecordAccount } from "../../lib/guardian-auth-state.js";
import { resolveBootstrapState } from "../../lib/bootstrap-state.js";
import { applySetupDefaults } from "../../lib/guardian-profile.js";
import { resolveGuardianSession } from "../../lib/guardian-session.js";
import { getInstanceToken } from "../../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { resolveVisitorSession } from "../../lib/visitor-session.js";
import type { ApiDeps } from "../deps.js";

export function onboardRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // The SPA bootstrap probe. Returns the lifecycle as a single
  // discriminated `BootstrapState` computed server-side — the SPA's gate is a
  // `switch (phase)` over this. Unauthenticated: it reads the session if present
  // but never requires one.
  app.get("/bootstrap", async (c) => {
    const session = await resolveGuardianSession(c, deps.db);
    const visitor = resolveVisitorSession(c);
    const visitorHasDashboardAccess =
      visitor !== null && deps.dashboardAccessState.isCloudEmailAllowed(visitor.email);

    // Opportunistically learn + record the cloud account that
    // owns this instance. Gated on a real guardian session so an anonymous probe
    // can't fan out to Rome Cloud. Fire-and-forget so the probe stays fast; it
    // swallows its own errors and surfaces nothing.
    if (session) void resolveAndRecordAccount(deps.db);

    const state = await resolveBootstrapState(deps.db, {
      cloudAuthEnabled: await deps.isCloudAuthEnabled(),
      romeCloudConfigured: getRomeCloudOrigin() !== null,
      instanceEnrolled: getInstanceToken() !== null,
      hasSession: session !== null || visitorHasDashboardAccess,
      dashboardVisitorAccessEnabled: deps.dashboardAccessState.hasCloudEmailAccess(),
    });

    return c.json(state);
  });

  // The whole of local-first setup. Creating the seat also finishes it: the
  // username becomes the guardian display name, the agent gets a preset
  // identity, and onboarding is marked complete, so the box drops straight into
  // the welcome conversation the way a cloud box does. The two names are
  // confirmed there rather than in a form.
  app.post("/onboard/create-account", async (c) => {
    // On a cloud-default instance the guardian seat is created
    // from the Rome Cloud session by the cloud sign-in callback, not here. This
    // local-password route is retired on that path and kept only for the
    // offline/self-hosted fallback (no Rome Cloud origin configured).
    if ((await deps.isCloudAuthEnabled()) && getRomeCloudOrigin() !== null) {
      return c.json({ error: "Cloud sign-in is the account source on this instance." }, 403);
    }

    const [existing] = await deps.db.select({ id: guardianAuth.id }).from(guardianAuth).limit(1);

    if (existing) {
      return c.json({ error: "Guardian already exists. Setup is disabled." }, 403);
    }

    const body = await c.req.json<{ userId?: string; password?: string }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { userId, password } = body;
    if (!userId || !password) {
      return c.json({ error: "userId and password are required" }, 400);
    }

    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const passwordHash = await hashPassword(password);

    await deps.db.insert(guardianAuth).values({
      id: uuidv4(),
      userId,
      passwordHash,
      createdAt: new Date(),
    });

    await applySetupDefaults(userId, {
      db: deps.db,
      settingsRepo: deps.settingsRepo,
      reactivateFloating: () => deps.routineEngine.reactivateFloating(),
    });

    issueGuardianSession(c, userId);
    deps.loginUsage.recordLogin("onboard");

    return c.json({ success: true });
  });

  app.post("/onboard/complete", async (c) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const session = verifySession(token);
    if (!session) {
      return c.json({ error: "Invalid session" }, 401);
    }

    await deps.db.update(guardianAuth).set({ onboardingComplete: true });

    return c.json({ success: true });
  });

  return app;
}
