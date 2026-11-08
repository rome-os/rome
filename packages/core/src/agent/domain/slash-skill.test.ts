import { describe, it, expect } from "@rstest/core";
import { parseSlashSkillInvocation, buildSlashSkillPrompt } from "./slash-skill.js";
import type { Skill, SkillCatalog } from "./skill.js";

function catalogWith(...names: string[]): Pick<SkillCatalog, "find"> {
  return {
    find: (name) => (names.includes(name) ? ({ name } as Skill) : undefined),
  };
}

describe("parseSlashSkillInvocation", () => {
  it("parses a catalog skill with task text", () => {
    expect(
      parseSlashSkillInvocation(
        "/app_creation build me a habit tracker",
        catalogWith("app_creation"),
      ),
    ).toEqual({ skillName: "app_creation", task: "build me a habit tracker" });
  });

  it("parses a bare command with no task", () => {
    expect(parseSlashSkillInvocation("/skill-import", catalogWith("skill-import"))).toEqual({
      skillName: "skill-import",
      task: "",
    });
  });

  it("parses an unscoped canonical skill id", () => {
    expect(
      parseSlashSkillInvocation(
        "/calendar:daily_brief summarize today",
        catalogWith("calendar:daily_brief"),
      ),
    ).toEqual({ skillName: "calendar:daily_brief", task: "summarize today" });
  });

  it("parses a scoped canonical skill id", () => {
    expect(
      parseSlashSkillInvocation(
        "/@ray/calendar:daily_brief summarize today",
        catalogWith("@ray/calendar:daily_brief"),
      ),
    ).toEqual({ skillName: "@ray/calendar:daily_brief", task: "summarize today" });
  });

  it("keeps multi-line task text", () => {
    const result = parseSlashSkillInvocation(
      "/app_creation build this:\n- a\n- b",
      catalogWith("app_creation"),
    );
    expect(result?.task).toBe("build this:\n- a\n- b");
  });

  it("returns null for a token that names no catalog skill", () => {
    expect(parseSlashSkillInvocation("/unknown do it", catalogWith("app_creation"))).toBeNull();
  });

  it("returns null for path-like text", () => {
    expect(parseSlashSkillInvocation("/etc/hosts looks wrong", catalogWith("etc"))).toBeNull();
  });

  it("returns null when the slash is not the first token", () => {
    expect(parseSlashSkillInvocation("use /app_creation", catalogWith("app_creation"))).toBeNull();
  });
});

describe("buildSlashSkillPrompt", () => {
  it("expands a known command into a read_skill instruction carrying the task", () => {
    const prompt = buildSlashSkillPrompt({ skillName: "app_creation", task: "build a tracker" });
    expect(prompt).toContain('invoked the skill "app_creation"');
    expect(prompt).toContain("read_skill");
    expect(prompt).toContain("Task: build a tracker");
  });

  it("asks for a task when none was given", () => {
    const prompt = buildSlashSkillPrompt({ skillName: "app_creation", task: "" });
    expect(prompt).toContain("ask what they want to do with it");
  });
});
