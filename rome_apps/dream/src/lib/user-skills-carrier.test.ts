import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  ensureUserSkillsCarrier,
  isInside,
  registerCarrierSkills,
  userSkillsCarrierDir,
} from "./user-skills-carrier.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "carrier-"));
  dir = join(root, "user-skills");
  await ensureUserSkillsCarrier(dir);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function addSkill(name: string): void {
  mkdirSync(join(dir, "skills", name), { recursive: true });
  writeFileSync(join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
}

describe("user-skills carrier", () => {
  it("resolves under the authoring root, honoring the override", () => {
    expect(userSkillsCarrierDir({ ROME_APP_AUTHORING_ROOT: "/x/apps" })).toBe(
      "/x/apps/user-skills",
    );
    expect(userSkillsCarrierDir({ ROME_PROFILE: "work" })).toMatch(
      /\.rome\/work\/projects\/apps\/user-skills$/,
    );
  });

  it("does not overwrite an existing carrier", async () => {
    writeFileSync(join(dir, "app.yaml"), "id: user-skills\nskills:\n  - skills/kept\n");
    await ensureUserSkillsCarrier(dir);
    expect(readFileSync(join(dir, "app.yaml"), "utf8")).toContain("skills/kept");
  });

  it("lists new skill folders and keeps existing entries", async () => {
    writeFileSync(
      join(dir, "app.yaml"),
      "id: user-skills\nskills:\n  - skills/imported\nweb:\n  manifest: web/manifest.json\n",
    );
    addSkill("imported");
    addSkill("reviewed");
    mkdirSync(join(dir, "skills", "no-skill-md"));

    expect(await registerCarrierSkills(dir)).toEqual(["skills/imported", "skills/reviewed"]);
    expect(readFileSync(join(dir, "app.yaml"), "utf8")).toBe(
      "id: user-skills\nskills:\n  - skills/imported\n  - skills/reviewed\nweb:\n  manifest: web/manifest.json\n",
    );
  });

  it("replaces the empty inline list", async () => {
    addSkill("first");
    await registerCarrierSkills(dir);
    const yaml = readFileSync(join(dir, "app.yaml"), "utf8");
    expect(yaml).toContain("skills:\n  - skills/first\n");
    expect(yaml).not.toContain("skills: []");
  });

  it("detects paths inside the carrier", () => {
    expect(isInside(dir, join(dir, "skills/a/SKILL.md"))).toBe(true);
    expect(isInside(dir, "skills/a/SKILL.md")).toBe(true);
    expect(isInside(dir, join(root, "other/SKILL.md"))).toBe(false);
    expect(isInside(dir, dir)).toBe(false);
  });
});
