import { AGENT_REPORTS_ENABLED_KEY } from "../../instance/feedback-client.js";
import { Hono } from "hono";
import type { ApiDeps } from "../deps.js";
import {
  ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING,
  redactAnthropicCompatibleCredentialsSetting,
} from "../../agent/index.js";
import { RELAY_SETTING_KEY, redactRelaySetting } from "../../relay/settings.js";
import {
  GUARDIAN_TIMEZONE_SETTING_KEY,
  applyGuardianTimezoneWrite,
} from "../../instance/timezone.js";
import {
  resolveSessionActorFromMaterial,
  sessionActorMaterial,
  sessionOwnerKey,
} from "../../access/session-actor.js";
import { isOnTeam } from "../../access/team.js";
import { parseTimeZone } from "../../lib/timezone.js";
import { APP_PERMISSIONS_SETTING_KEY } from "../../apps/app-permissions.js";
import { DASHBOARD_ACCESS_SETTING_KEY } from "../../access/dashboard-access-config.js";
import { CONCIERGE_FOLLOWING_SETTING_KEY } from "../../concierge/following.js";
import { SPEECH_SESSIONS_SETTING_KEY } from "../../voice-output/rome-cloud-speech-credentials.js";
import { isComputerUseApprovalSetting } from "../../core/computer-use-approvals.js";

// Keys enforced from an in-memory snapshot that only their dedicated route
// refreshes. Persisting one here would leave the stored and enforced policies
// disagreeing until restart.
const DEDICATED_ROUTE_KEYS: Record<string, string> = {
  [APP_PERMISSIONS_SETTING_KEY]: "/api/public-access",
  [DASHBOARD_ACCESS_SETTING_KEY]: "/api/dashboard-access",
};

// Each person's Concierge state: their follows, rules and time zone. Only
// owner-scoped Concierge actions read or write it, so no dashboard user reads
// another's here.
const CONCIERGE_PRIVATE_KEYS = [CONCIERGE_FOLLOWING_SETTING_KEY];

// The speech sessions Rome holds, each with a provider credential. Only the
// speaking module reads or writes them.
const VOICE_PRIVATE_KEYS = [SPEECH_SESSIONS_SETTING_KEY];

function redactSettingsForResponse(settings: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...settings };
  for (const key of [...CONCIERGE_PRIVATE_KEYS, ...VOICE_PRIVATE_KEYS]) delete redacted[key];
  for (const key of Object.keys(redacted)) {
    if (isComputerUseApprovalSetting(key)) delete redacted[key];
  }
  if (ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING in redacted) {
    redacted[ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING] =
      redactAnthropicCompatibleCredentialsSetting(
        redacted[ANTHROPIC_COMPATIBLE_CREDENTIALS_SETTING],
      );
  }
  if (RELAY_SETTING_KEY in redacted) {
    redacted[RELAY_SETTING_KEY] = redactRelaySetting(redacted[RELAY_SETTING_KEY]);
  }
  return redacted;
}

export function settingsRoutes(deps: ApiDeps): Hono {
  const app = new Hono();

  app.get("/settings", async (c) => {
    const result = await deps.settingsRepo.getAll();
    return c.json(redactSettingsForResponse(result));
  });

  app.put("/settings", async (c) => {
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);

    if (AGENT_REPORTS_ENABLED_KEY in body && typeof body[AGENT_REPORTS_ENABLED_KEY] !== "boolean") {
      return c.json({ error: "feedback.agentReportsEnabled must be a boolean" }, 400);
    }

    if (
      "aiTools.codex.allowCredits" in body &&
      typeof body["aiTools.codex.allowCredits"] !== "boolean"
    ) {
      return c.json({ error: "aiTools.codex.allowCredits must be a boolean" }, 400);
    }

    for (const [key, route] of Object.entries(DEDICATED_ROUTE_KEYS)) {
      if (key in body) {
        return c.json({ error: `${key} is managed by PUT ${route}, not /api/settings.` }, 400);
      }
    }
    for (const key of CONCIERGE_PRIVATE_KEYS) {
      if (key in body) {
        return c.json({ error: `${key} is managed by the Concierge, not /api/settings.` }, 400);
      }
    }
    for (const key of VOICE_PRIVATE_KEYS) {
      if (key in body) {
        return c.json({ error: `${key} is managed by voice mode, not /api/settings.` }, 400);
      }
    }
    if (Object.keys(body).some(isComputerUseApprovalSetting)) {
      return c.json(
        { error: "Computer-use approvals are managed by the device approval route." },
        400,
      );
    }

    // guardianTimezone is scheduler input: route it through the shared
    // write helper (validate + persist/clear + reschedule floating routines) so
    // this and onboarding stay in sync. A non-empty invalid value is rejected.
    if (GUARDIAN_TIMEZONE_SETTING_KEY in body) {
      const result = await applyGuardianTimezoneWrite(body[GUARDIAN_TIMEZONE_SETTING_KEY], {
        settingsRepo: deps.settingsRepo,
        reactivateFloating: () => deps.routineEngine.reactivateFloating(),
      });
      if (result.status === "invalid") {
        return c.json({ error: result.error }, 400);
      }
      // The helper owns the persist/clear for this key; don't double-write it.
      delete body[GUARDIAN_TIMEZONE_SETTING_KEY];
    }

    for (const [key, value] of Object.entries(body)) {
      await deps.settingsRepo.set(key, value);
    }

    if ("aiTools.codex.allowCredits" in body) await deps.modelAccounts.refresh("openai");
    return c.json({ ok: true });
  });

  // The zone the SPA detects in the browser on first load. A cloud sign-in
  // completes setup server-side and cannot know the guardian's zone, so this
  // fills it in. It only writes when no zone is stored: a zone the guardian set
  // is never overwritten by whichever browser loads the dashboard next.
  app.post("/settings/guardian-timezone/detected", async (c) => {
    // A dashboard admin also reaches `phase: "ready"` and reports their own
    // browser's zone, which must not become the zone every floating routine is
    // scheduled in. Theirs is their Concierge's time zone instead.
    const actor = await resolveSessionActorFromMaterial(sessionActorMaterial(c), deps.db);
    if (!isOnTeam(actor, deps.dashboardAccessState)) {
      return c.json({ error: "Guardian session required" }, 403);
    }
    const body = await c.req
      .json<Record<string, unknown>>()
      .catch(() => ({}) as Record<string, unknown>);
    const owner = sessionOwnerKey(actor);
    if (actor.kind === "visitor" && owner) {
      const zone = parseTimeZone(body.timezone);
      if (zone && deps.concierge) await deps.concierge.following.setTimezone(owner, zone);
      return c.json({ status: "unchanged" });
    }
    const stored = parseTimeZone(await deps.settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY));
    if (stored) {
      return c.json({ status: "unchanged", tzid: stored });
    }
    const result = await applyGuardianTimezoneWrite(body.timezone, {
      settingsRepo: deps.settingsRepo,
      reactivateFloating: () => deps.routineEngine.reactivateFloating(),
    });
    if (result.status === "invalid") {
      return c.json({ error: result.error }, 400);
    }
    return c.json(result);
  });

  return app;
}
