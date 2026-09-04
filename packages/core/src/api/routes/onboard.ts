import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { v4 as uuidv4 } from "uuid";
import { guardianAuth, persons, settings } from "../../db/schema.js";
import { STRANGER_PERSON_ID, STRANGER_PERSON_DISPLAY_NAME } from "../../constants.js";
import { generatePersonSlug } from "../../db/repositories/person-mapping.js";
import {
  ensureProfileMemoryInitialized,
  getGuardianProfileFile,
  getRelationshipDir,
  GUARDIAN_PROFILE_PATH,
} from "../../profile-memory.js";
import { COOKIE_NAME, hashPassword, issueGuardianSession, verifySession } from "../../lib/auth.js";
import { resolveAndRecordAccount } from "../../lib/guardian-auth-state.js";
import { resolveBootstrapState } from "../../lib/bootstrap-state.js";
import { resolveGuardianSession } from "../../lib/guardian-session.js";
import { getInstanceToken } from "../../lib/instance-identity.js";
import { getRomeCloudOrigin } from "../../lib/rome-cloud-origin.js";
import { resolveVisitorSession } from "../../lib/visitor-session.js";
import { createLogger } from "../../logger.js";
import { applyGuardianTimezoneWrite } from "../../routines/guardian-timezone.js";
import type { ApiDeps } from "../deps.js";

const log = createLogger("api:onboard");

const RESUMABLE_SETTING_KEYS = new Set([
  "agentName",
  "agentPurpose",
  "guardianName",
  "guardianTimezone",
  "guardianX",
  "guardianLinkedin",
  "interests",
  "onboardingStep",
]);

interface SetupProfile {
  agentName?: string;
  agentPurpose?: string;
  guardianName?: string;
  guardianTimezone?: string;
  guardianX?: string;
  guardianLinkedin?: string;
  interests?: string[];
}

export function onboardRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  // The SPA bootstrap probe. Returns the lifecycle as a single
  // discriminated `BootstrapState` computed server-side — the SPA's gate is a
  // `switch (phase)` over this. Unauthenticated (it reads the session if present
  // but never requires one); the resume payload lives on `/onboard/draft`.
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

  // Returns the authenticated guardian's id plus any partially-filled onboarding
  // settings, so OnboardPage can rehydrate. Only a signed-in guardian
  // mid-onboarding calls this.
  app.get("/onboard/draft", async (c) => {
    const session = await resolveGuardianSession(c, deps.db);
    if (!session) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const rows = await deps.db.select().from(settings);
    const draft: Record<string, unknown> = {};
    for (const row of rows) {
      if (!RESUMABLE_SETTING_KEYS.has(row.key)) continue;
      draft[row.key] = row.value;
    }

    return c.json({ userId: session.userId, settings: draft });
  });

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

    await deps.db
      .insert(persons)
      .values({
        id: STRANGER_PERSON_ID,
        displayName: STRANGER_PERSON_DISPLAY_NAME,
        bondLevel: "other",
        approved: true,
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    issueGuardianSession(c, userId);

    return c.json({ success: true });
  });

  app.post("/onboard/setup", async (c) => {
    const token = getCookie(c, COOKIE_NAME);
    if (!token) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const session = verifySession(token);
    if (!session) {
      return c.json({ error: "Invalid session" }, 401);
    }

    const [existing] = await deps.db.select({ id: guardianAuth.id }).from(guardianAuth).limit(1);

    if (!existing) {
      return c.json({ error: "No account found. Please create an account first." }, 400);
    }

    const body = await c.req.json<{ profile?: SetupProfile }>().catch(() => null);
    if (!body) {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const { profile } = body;

    // The guardian's display name is required: it is what the greeting and the
    // person graph render, and there is no acceptable machine fallback — echoing
    // the cloud accountId here is exactly the "Hi <uuid>" bug. Reject before any
    // write so a blank name never reaches the person row or the settings KV.
    const guardianName = profile?.guardianName?.trim();
    if (!guardianName) {
      return c.json({ error: "Guardian name is required" }, 400);
    }

    const guardianPersonId = generatePersonSlug(guardianName) || uuidv4();
    await deps.db
      .insert(persons)
      .values({
        id: guardianPersonId,
        displayName: guardianName,
        bondLevel: "guardian",
        profilePath: GUARDIAN_PROFILE_PATH,
        approved: true,
        createdAt: new Date(),
      })
      .onConflictDoNothing();

    if (profile) {
      const profileMemoryDir = ensureProfileMemoryInitialized();
      const relationshipDir = getRelationshipDir();

      try {
        mkdirSync(relationshipDir, { recursive: true });

        const guardianLines = ["# Guardian Profile", ""];
        guardianLines.push(`**Name:** ${guardianName}`, "");
        if (profile.guardianTimezone)
          guardianLines.push(`**Timezone:** ${profile.guardianTimezone}`, "");
        if (profile.guardianX) {
          const xHandle = profile.guardianX.replace(/^@/, "");
          guardianLines.push(`**X (Twitter):** https://x.com/${xHandle}`, "");
        }
        if (profile.guardianLinkedin) {
          const liHandle = profile.guardianLinkedin.replace(/^\/in\//, "");
          guardianLines.push(`**LinkedIn:** https://www.linkedin.com/in/${liHandle}`, "");
        }
        if (profile.interests && profile.interests.length > 0) {
          guardianLines.push("## Interests", "", profile.interests.join(", "), "");
        }
        if (guardianLines.length > 2) {
          writeFileSync(getGuardianProfileFile(), guardianLines.join("\n"));
        }

        mkdirSync(profileMemoryDir, { recursive: true });
        const identityLines = ["# Identity", ""];
        if (profile.agentName) identityLines.push(`**Agent Name:** ${profile.agentName}`, "");
        if (profile.agentPurpose) identityLines.push("## Purpose", "", profile.agentPurpose, "");
        if (identityLines.length > 2) {
          writeFileSync(join(profileMemoryDir, "IDENTITY.md"), identityLines.join("\n"));
        }
      } catch (err) {
        log.error("failed to write profile files", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const now = new Date();
      const profileSettings: Record<string, unknown> = {
        agentName: profile.agentName,
        agentPurpose: profile.agentPurpose,
        guardianName,
        guardianX: profile.guardianX,
        guardianLinkedin: profile.guardianLinkedin,
        interests: profile.interests,
      };
      for (const [key, value] of Object.entries(profileSettings)) {
        if (value !== undefined && value !== null) {
          await deps.db
            .insert(settings)
            .values({ key, value, updatedAt: now })
            .onConflictDoUpdate({
              target: settings.key,
              set: { value, updatedAt: now },
            });
        }
      }

      // guardianTimezone is scheduler input: route it through the shared write
      // helper so floating routines created at boot (e.g. system_upgrade, made
      // before onboarding) are rescheduled to the guardian's zone now instead of
      // staying on the host zone until restart. Invalid → skip, not
      // fail onboarding.
      if (profile.guardianTimezone !== undefined) {
        const tzResult = await applyGuardianTimezoneWrite(profile.guardianTimezone, {
          settingsRepo: deps.settingsRepo,
          reactivateFloating: () => deps.routineEngine.reactivateFloating(),
        });
        if (tzResult.status === "invalid") {
          log.warn("ignoring invalid guardianTimezone during onboarding", {
            value: profile.guardianTimezone,
          });
        }
      }
    }

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
