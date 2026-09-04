/**
 * `applyGuardianProfile` — the one write path for the guardian profile. Pins:
 *   - a blank name with nothing stored writes nothing;
 *   - a first write creates the guardian person row, the settings, and the
 *     profile notes;
 *   - a rename keeps the person row's id and refreshes the notes from the merge
 *     of stored and given fields, so a name-only write does not drop the
 *     timezone or the agent purpose from the notes;
 *   - a timezone goes through the shared timezone write.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, rs } from "@rstest/core";
import { eq } from "drizzle-orm";

const state = rs.hoisted(() => ({ memoryDir: "" }));

rs.mock("../profile-memory.js", () => ({
  ensureProfileMemoryInitialized: rs.fn(() => state.memoryDir),
}));

import { persons, settings } from "../db/schema.js";
import { SettingsRepository } from "../db/repositories/settings.js";
import { GUARDIAN_TIMEZONE_SETTING_KEY } from "../routines/guardian-timezone.js";
import { createTestDb } from "../test/helpers.js";
import { applyGuardianProfile, defaultGuardianName } from "./guardian-profile.js";

const testDb = createTestDb();
afterAll(() => testDb.close());

let settingsRepo: SettingsRepository;
let reactivateFloating: ReturnType<typeof rs.fn>;

beforeEach(() => {
  testDb.db.delete(persons).run();
  testDb.db.delete(settings).run();
  state.memoryDir = mkdtempSync(join(tmpdir(), "guardian-profile-"));
  settingsRepo = new SettingsRepository(testDb.db);
  reactivateFloating = rs.fn(async () => {});
});

function deps() {
  return { db: testDb.db, settingsRepo, reactivateFloating };
}

function guardianRows() {
  return testDb.db.select().from(persons).where(eq(persons.bondLevel, "guardian")).all();
}

describe("applyGuardianProfile", () => {
  it("rejects a blank name with nothing stored and writes nothing", async () => {
    const result = await applyGuardianProfile({ guardianName: "  ", agentName: "Atlas" }, deps());

    expect(result).toEqual({ ok: false, error: "guardian_name_required" });
    expect(guardianRows()).toHaveLength(0);
    expect(await settingsRepo.get("agentName")).toBeNull();
    expect(existsSync(join(state.memoryDir, "IDENTITY.md"))).toBe(false);
  });

  it("creates the guardian person row, the settings, and the profile notes", async () => {
    const result = await applyGuardianProfile(
      { guardianName: "Alex Doe", agentName: "Atlas", agentPurpose: "A creature of weight." },
      deps(),
    );

    expect(result).toMatchObject({ ok: true, guardianName: "Alex Doe", personId: "alex-doe" });
    const [row] = guardianRows();
    expect(row).toMatchObject({
      id: "alex-doe",
      displayName: "Alex Doe",
      profilePath: "memory/relationship/GUARDIAN.md",
      approved: true,
    });
    expect(await settingsRepo.get("guardianName")).toBe("Alex Doe");
    expect(await settingsRepo.get("agentName")).toBe("Atlas");
    expect(await settingsRepo.get("agentPurpose")).toBe("A creature of weight.");
    expect(readFileSync(join(state.memoryDir, "relationship", "GUARDIAN.md"), "utf8")).toContain(
      "**Name:** Alex Doe",
    );
    const identity = readFileSync(join(state.memoryDir, "IDENTITY.md"), "utf8");
    expect(identity).toContain("**Agent Name:** Atlas");
    expect(identity).toContain("A creature of weight.");
  });

  it("renames in place and keeps stored fields in the notes on a partial write", async () => {
    await applyGuardianProfile(
      {
        guardianName: "Alex",
        agentName: "Atlas",
        agentPurpose: "A creature of weight.",
        guardianTimezone: "Asia/Tokyo",
      },
      deps(),
    );
    const [before] = guardianRows();

    const result = await applyGuardianProfile(
      { guardianName: "Alexandra", agentName: "Nova" },
      deps(),
    );

    expect(result).toMatchObject({ ok: true, personId: before.id });
    const rows = guardianRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: before.id, displayName: "Alexandra" });
    expect(await settingsRepo.get("guardianName")).toBe("Alexandra");
    expect(await settingsRepo.get("agentName")).toBe("Nova");
    expect(await settingsRepo.get("agentPurpose")).toBe("A creature of weight.");
    const guardianNotes = readFileSync(
      join(state.memoryDir, "relationship", "GUARDIAN.md"),
      "utf8",
    );
    expect(guardianNotes).toContain("**Name:** Alexandra");
    expect(guardianNotes).toContain("**Timezone:** Asia/Tokyo");
    const identity = readFileSync(join(state.memoryDir, "IDENTITY.md"), "utf8");
    expect(identity).toContain("**Agent Name:** Nova");
    expect(identity).toContain("A creature of weight.");
  });

  it("keeps the stored name when the write carries only the agent name", async () => {
    await applyGuardianProfile({ guardianName: "Alex" }, deps());

    const result = await applyGuardianProfile({ agentName: "Nova" }, deps());

    expect(result).toMatchObject({ ok: true, guardianName: "Alex" });
    expect(await settingsRepo.get("guardianName")).toBe("Alex");
    expect(await settingsRepo.get("agentName")).toBe("Nova");
  });

  it("routes the timezone through the shared write and reschedules floating routines", async () => {
    await applyGuardianProfile({ guardianName: "Alex", guardianTimezone: "Asia/Tokyo" }, deps());

    expect(await settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBe("Asia/Tokyo");
    expect(reactivateFloating).toHaveBeenCalledOnce();
  });

  it("skips an invalid timezone without failing the write", async () => {
    const result = await applyGuardianProfile(
      { guardianName: "Alex", guardianTimezone: "Mars/Olympus" },
      deps(),
    );

    expect(result).toMatchObject({ ok: true });
    expect(await settingsRepo.get(GUARDIAN_TIMEZONE_SETTING_KEY)).toBeNull();
    expect(reactivateFloating).not.toHaveBeenCalled();
  });

  it("falls back to a uuid id when a contact already holds the slug", async () => {
    testDb.db
      .insert(persons)
      .values({
        id: "alex",
        displayName: "Alex",
        bondLevel: "acquaintance",
        approved: true,
        createdAt: new Date(),
      })
      .run();

    const result = await applyGuardianProfile({ guardianName: "Alex" }, deps());

    expect(result.ok).toBe(true);
    const [row] = guardianRows();
    expect(row.id).not.toBe("alex");
    expect(row.displayName).toBe("Alex");
  });
});

describe("defaultGuardianName", () => {
  it("prefers the name claim, then the email local part, then Guardian", () => {
    expect(defaultGuardianName({ name: " Alex Doe ", email: "alex@example.com" })).toBe("Alex Doe");
    expect(defaultGuardianName({ email: "alex.doe@example.com" })).toBe("alex.doe");
    expect(defaultGuardianName({ name: "  ", email: "" })).toBe("Guardian");
    expect(defaultGuardianName({})).toBe("Guardian");
  });
});
