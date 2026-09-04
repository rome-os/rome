import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
import type { DrizzleDb } from "../db/index.js";
import { guardianAuth, persons } from "../db/schema.js";
import { pickRandomAgentPreset } from "./agent-presets.js";
import { generatePersonSlug } from "../db/repositories/person-mapping.js";
import type { SettingsRepository } from "../db/repositories/settings.js";
import { createLogger } from "../logger.js";
import { ensureProfileMemoryInitialized } from "../profile-memory.js";
import { applyGuardianTimezoneWrite } from "../routines/guardian-timezone.js";

const log = createLogger("guardian-profile");

/** The guardian person row's profile note, relative to the profile memory dir. */
export const GUARDIAN_PROFILE_PATH = "memory/relationship/GUARDIAN.md";

/** The guardian and agent identity every setup path writes. Only the fields
 *  present are written; an absent field keeps its stored value. */
export interface GuardianProfileInput {
  guardianName?: string;
  agentName?: string;
  agentPurpose?: string;
  guardianTimezone?: string;
  guardianX?: string;
  guardianLinkedin?: string;
  interests?: string[];
}

export interface GuardianProfileDeps {
  db: DrizzleDb;
  settingsRepo: Pick<SettingsRepository, "get" | "set" | "delete">;
  /** Reschedule floating routines after a timezone change. */
  reactivateFloating: () => Promise<void>;
}

export type GuardianProfileResult =
  | { ok: true; guardianName: string; personId: string }
  | { ok: false; error: "guardian_name_required" };

/**
 * The single write path for the guardian profile: the guardian person row, the
 * profile memory notes, and the profile settings. Every setup path (the
 * onboarding page, the cloud sign-in callback, the welcome conversation) goes
 * through here so they write the same fields.
 *
 * A blank `guardianName` with nothing stored fails before any write, so a
 * placeholder such as the cloud account id never becomes the display name.
 * A rename keeps the existing guardian person row and its id. An invalid
 * timezone is skipped, not an error.
 */
export async function applyGuardianProfile(
  input: GuardianProfileInput,
  deps: GuardianProfileDeps,
): Promise<GuardianProfileResult> {
  const stored = await readStoredProfile(deps.settingsRepo);
  const guardianName = input.guardianName?.trim() || stored.guardianName?.trim() || "";
  if (!guardianName) {
    return { ok: false, error: "guardian_name_required" };
  }

  const personId = await upsertGuardianPerson(deps.db, guardianName);

  const merged: GuardianProfileInput = {
    ...stored,
    ...definedFields(input),
    guardianName,
  };
  writeProfileNotes(merged);

  const settingsWrites: Record<string, unknown> = {
    ...definedFields(input),
    guardianName,
  };
  delete settingsWrites.guardianTimezone;
  for (const [key, value] of Object.entries(settingsWrites)) {
    await deps.settingsRepo.set(key, value);
  }

  // guardianTimezone is scheduler input, so it goes through the shared write
  // helper, which also reschedules floating routines created before setup.
  if (input.guardianTimezone !== undefined) {
    const result = await applyGuardianTimezoneWrite(input.guardianTimezone, {
      settingsRepo: deps.settingsRepo,
      reactivateFloating: deps.reactivateFloating,
    });
    if (result.status === "invalid") {
      log.warn("ignoring invalid guardianTimezone during setup", {
        value: input.guardianTimezone,
      });
    }
  }

  return { ok: true, guardianName, personId };
}

/**
 * Finish a fresh seat's setup: write the display name the caller derived from
 * its identity source, give the agent a preset name and purpose, and mark
 * onboarding complete. Both seat origins call this — the cloud sign-in callback
 * with the identity assertion's name, the local create-account route with the
 * chosen username — so every fresh instance reaches the welcome conversation
 * with both names already set and no setup form left to fill.
 *
 * Call once, after the guardian row exists. A blank `guardianName` leaves the
 * profile unwritten but still completes setup, so a caller with no usable name
 * is never stranded mid-onboarding.
 */
export async function applySetupDefaults(
  guardianName: string,
  deps: GuardianProfileDeps,
): Promise<void> {
  const preset = pickRandomAgentPreset();
  await applyGuardianProfile(
    { guardianName, agentName: preset.name, agentPurpose: preset.purpose },
    deps,
  );
  await deps.db.update(guardianAuth).set({ onboardingComplete: true });
}

/** The guardian name a cloud sign-in starts with: the identity assertion's
 *  `name` claim, else the local part of its email, else "Guardian". */
export function defaultGuardianName(claims: { name?: string; email?: string }): string {
  const name = claims.name?.trim();
  if (name) return name;
  const local = claims.email?.split("@")[0]?.trim();
  if (local) return local;
  return "Guardian";
}

const PROFILE_SETTING_KEYS = [
  "guardianName",
  "agentName",
  "agentPurpose",
  "guardianTimezone",
  "guardianX",
  "guardianLinkedin",
  "interests",
] as const;

async function readStoredProfile(
  settingsRepo: Pick<SettingsRepository, "get">,
): Promise<GuardianProfileInput> {
  const stored: Record<string, unknown> = {};
  for (const key of PROFILE_SETTING_KEYS) {
    const value = await settingsRepo.get(key);
    if (value !== null && value !== undefined) stored[key] = value;
  }
  return stored as GuardianProfileInput;
}

function definedFields(input: GuardianProfileInput): GuardianProfileInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined && value !== null),
  ) as GuardianProfileInput;
}

async function upsertGuardianPerson(db: DrizzleDb, guardianName: string): Promise<string> {
  const [guardian] = await db
    .select({ id: persons.id, displayName: persons.displayName })
    .from(persons)
    .where(eq(persons.bondLevel, "guardian"))
    .limit(1);
  if (guardian) {
    if (guardian.displayName !== guardianName) {
      await db
        .update(persons)
        .set({ displayName: guardianName })
        .where(eq(persons.id, guardian.id));
    }
    return guardian.id;
  }

  // The slug is the readable id, unless a contact already holds it.
  const slug = generatePersonSlug(guardianName);
  const [taken] = slug
    ? await db.select({ id: persons.id }).from(persons).where(eq(persons.id, slug)).limit(1)
    : [];
  const id = slug && !taken ? slug : uuidv4();
  await db.insert(persons).values({
    id,
    displayName: guardianName,
    bondLevel: "guardian",
    profilePath: GUARDIAN_PROFILE_PATH,
    approved: true,
    createdAt: new Date(),
  });
  return id;
}

function writeProfileNotes(profile: GuardianProfileInput): void {
  try {
    const profileMemoryDir = ensureProfileMemoryInitialized();
    const relationshipDir = join(profileMemoryDir, "relationship");
    mkdirSync(relationshipDir, { recursive: true });

    const guardianLines = ["# Guardian Profile", "", `**Name:** ${profile.guardianName}`, ""];
    if (profile.guardianTimezone) {
      guardianLines.push(`**Timezone:** ${profile.guardianTimezone}`, "");
    }
    if (profile.guardianX) {
      const handle = profile.guardianX.replace(/^@/, "");
      guardianLines.push(`**X (Twitter):** https://x.com/${handle}`, "");
    }
    if (profile.guardianLinkedin) {
      const handle = profile.guardianLinkedin.replace(/^\/in\//, "");
      guardianLines.push(`**LinkedIn:** https://www.linkedin.com/in/${handle}`, "");
    }
    if (profile.interests && profile.interests.length > 0) {
      guardianLines.push("## Interests", "", profile.interests.join(", "), "");
    }
    writeFileSync(join(relationshipDir, "GUARDIAN.md"), guardianLines.join("\n"));

    const identityLines = ["# Identity", ""];
    if (profile.agentName) identityLines.push(`**Agent Name:** ${profile.agentName}`, "");
    if (profile.agentPurpose) identityLines.push("## Purpose", "", profile.agentPurpose, "");
    if (identityLines.length > 2) {
      writeFileSync(join(profileMemoryDir, "IDENTITY.md"), identityLines.join("\n"));
    }
  } catch (err) {
    log.error("failed to write profile notes", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
