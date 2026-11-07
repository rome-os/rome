import { describe, expect, it } from "@rstest/core";
import type { ChangedFile } from "../../lib/changes.js";
import { dreamAppChangeGroups } from "./run-detail-files.js";

function file(overrides: Partial<ChangedFile>): ChangedFile {
  return {
    path: "/apps/notes/src/index.ts",
    area: "other",
    label: "notes/src/index.ts",
    memoryFile: null,
    skillName: null,
    skillAppId: null,
    changes: [],
    attribution: null,
    ...overrides,
  };
}

describe("dreamAppChangeGroups", () => {
  it("groups only explicit app provenance and keeps legacy rows in other files", () => {
    const practiceFile = file({ attribution: "practice" });
    const unknownFile = file({ path: "/apps/notes/src/guardian.ts", attribution: "unattributed" });
    const practiceSkill = file({
      path: "/rome_apps/notes/src/skills/export/SKILL.md",
      area: "skill",
      label: "notes/src/skills/export/SKILL.md",
      skillName: "export",
      skillAppId: "notes",
      attribution: "practice",
    });
    const unknownSkill = file({
      path: "/rome_apps/notes/src/skills/import/SKILL.md",
      area: "skill",
      label: "notes/src/skills/import/SKILL.md",
      skillName: "import",
      skillAppId: "notes",
      attribution: "unattributed",
    });
    const legacyAppFile = file({ path: "/apps/notes/src/old.ts" });
    const legacySkill = file({
      path: "/rome_apps/notes/src/skills/legacy/SKILL.md",
      area: "skill",
      label: "notes/src/skills/legacy/SKILL.md",
      skillName: "legacy",
      skillAppId: "notes",
    });
    const memoryFile = file({ area: "memory", path: "/memory/MEMORY.md", attribution: "practice" });

    const groups = dreamAppChangeGroups([
      practiceFile,
      unknownFile,
      practiceSkill,
      unknownSkill,
      legacyAppFile,
      legacySkill,
      memoryFile,
    ]);

    expect(groups.touchedByPractice).toEqual([practiceFile, practiceSkill]);
    expect(groups.sourceUnknown).toEqual([unknownFile, unknownSkill]);
    expect(groups.other).toEqual([legacyAppFile, legacySkill]);
  });
});
