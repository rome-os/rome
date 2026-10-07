import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import {
  changedSkills,
  commitCarrier,
  ensureUserSkillsCarrier,
  registerCarrierSkills,
  restoreCarrier,
  snapshotCarrierSkills,
  userSkillsCarrierDir,
  withCarrierLock,
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

    expect(await registerCarrierSkills(dir, ["imported", "reviewed"])).toEqual([
      "skills/imported",
      "skills/reviewed",
    ]);
    expect(readFileSync(join(dir, "app.yaml"), "utf8")).toBe(
      "id: user-skills\nskills:\n  - skills/imported\n  - skills/reviewed\nweb:\n  manifest: web/manifest.json\n",
    );
  });

  it("replaces the empty inline list", async () => {
    addSkill("first");
    addSkill("unrelated");
    await registerCarrierSkills(dir, ["first"]);
    const yaml = readFileSync(join(dir, "app.yaml"), "utf8");
    expect(yaml).toContain("skills:\n  - skills/first\n");
    expect(yaml).not.toContain("skills: []");
    expect(yaml).not.toContain("unrelated");
  });

  it("keeps object, flow and zero-indent entries and dedupes by path", async () => {
    addSkill("kept");
    addSkill("flow");
    addSkill("new");
    writeFileSync(
      join(dir, "app.yaml"),
      "id: user-skills\nskills:\n- path: skills/kept\n  publicName: kept\n# a comment\n- ./skills/flow/\nweb:\n  manifest: web/manifest.json\n",
    );
    await registerCarrierSkills(dir, ["kept", "flow", "new"]);
    expect(readFileSync(join(dir, "app.yaml"), "utf8")).toBe(
      "id: user-skills\nskills:\n  - path: skills/kept\n    publicName: kept\n  # a comment\n  - ./skills/flow/\n  - skills/new\nweb:\n  manifest: web/manifest.json\n",
    );

    writeFileSync(join(dir, "app.yaml"), "id: user-skills\nskills: [skills/kept, skills/x/y]\n");
    await registerCarrierSkills(dir, ["kept", "new"]);
    expect(readFileSync(join(dir, "app.yaml"), "utf8")).toBe(
      "id: user-skills\nskills:\n  - skills/kept\n  - skills/x/y\n  - skills/new\n",
    );
  });

  it("reports added and edited skills between snapshots", async () => {
    addSkill("same");
    addSkill("edited");
    const before = await snapshotCarrierSkills(dir);
    writeFileSync(join(dir, "skills", "edited", "SKILL.md"), "---\nname: edited\n---\nmore\n");
    addSkill("added");
    expect(changedSkills(before, await snapshotCarrierSkills(dir))).toEqual(["added", "edited"]);
  });

  it("restores the carrier to its state before a run", async () => {
    addSkill("edited");
    const appYaml = readFileSync(join(dir, "app.yaml"), "utf8");
    const before = await snapshotCarrierSkills(dir);
    writeFileSync(join(dir, "skills", "edited", "SKILL.md"), "broken");
    addSkill("added");
    await registerCarrierSkills(dir, ["edited", "added"]);

    await restoreCarrier(dir, appYaml, before, ["added", "edited"]);

    expect(readFileSync(join(dir, "app.yaml"), "utf8")).toBe(appYaml);
    expect(readFileSync(join(dir, "skills", "edited", "SKILL.md"), "utf8")).toContain(
      "name: edited",
    );
    expect(existsSync(join(dir, "skills", "added"))).toBe(false);
  });

  it("serializes overlapping registrations so neither skill is dropped", async () => {
    const order: string[] = [];
    const slow = withCarrierLock(dir, async () => {
      order.push("a:start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("a:end");
    });
    const fast = withCarrierLock(dir, async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("commits the carrier when it is a git repo", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    addSkill("committed");
    writeFileSync(join(dir, "unrelated.txt"), "guardian's own edit\n");
    await commitCarrier(dir, ["committed"]);
    expect(git("log", "--format=%s")).toBe("Dream: update skill committed");
    expect(git("status", "--porcelain")).toBe(
      "?? assets/\n?? package.json\n?? unrelated.txt\n?? web/".trim(),
    );
    await commitCarrier(dir, ["committed"]);
    expect(git("rev-list", "--count", "HEAD")).toBe("1");
  });
});
