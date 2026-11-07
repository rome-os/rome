import { describe, it, expect } from "@rstest/core";
import { parseSkillFrontmatter, parseSkillFrontmatterResult } from "./skill-frontmatter.js";

describe("parseSkillFrontmatter", () => {
  it("parses a kebab-case name", () => {
    const content = `---
name: deep-research
description: Research a topic deeply.
---
body`;
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "deep-research",
      description: "Research a topic deeply.",
      tools: undefined,
    });
  });

  it("parses an underscore name and inline tools", () => {
    const content = `---
name: app_creation
description: Scaffold a new app.
tools: [Read, Edit]
---
body`;
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "app_creation",
      description: "Scaffold a new app.",
      tools: ["Read", "Edit"],
    });
  });

  it("rejects a name with internal whitespace", () => {
    const content = `---
name: deep research
description: Research a topic deeply.
---
body`;
    // A spaced name can't match the typed `/<token>` slash pattern, so it must
    // never enter the catalog.
    expect(parseSkillFrontmatter(content)).toBeNull();
  });

  it("rejects a name containing the namespace separator", () => {
    const result = parseSkillFrontmatterResult(`---\nname: app:skill\ndescription: Bad.\n---`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("name-has-reserved-separator");
  });

  it("reads a quoted name and description without their quotes", () => {
    const content = `---
name: "sample-skill"
description: 'A sample skill.'
---
body`;
    expect(parseSkillFrontmatter(content)).toEqual({
      name: "sample-skill",
      description: "A sample skill.",
      tools: undefined,
    });
  });

  it("unescapes quotes inside a quoted description", () => {
    const single = parseSkillFrontmatter(`---\nname: a\ndescription: 'It''s a skill.'\n---`);
    expect(single?.description).toBe("It's a skill.");
    const double = parseSkillFrontmatter(`---\nname: a\ndescription: "Say \\"hi\\"."\n---`);
    expect(double?.description).toBe('Say "hi".');
  });

  it("decodes YAML-only escapes in a quoted name", () => {
    const content = `---\nname: "sample\\x2dskill"\ndescription: x\n---`;
    const result = parseSkillFrontmatterResult(content);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.name).toBe("sample-skill");
  });

  it("still rejects a quoted name with internal whitespace", () => {
    const result = parseSkillFrontmatterResult(`---\nname: "deep research"\ndescription: x\n---`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("name-has-whitespace");
  });

  it("returns null without frontmatter", () => {
    expect(parseSkillFrontmatter("no frontmatter here")).toBeNull();
  });

  it("returns null when name or description is missing", () => {
    expect(parseSkillFrontmatter(`---\nname: only-name\n---`)).toBeNull();
  });
});

describe("parseSkillFrontmatterResult", () => {
  it("returns the parsed fields on success", () => {
    const content = `---
name: story_authoring
description: Author a new mystery.
tools: [Read, Write]
---
body`;
    expect(parseSkillFrontmatterResult(content)).toEqual({
      ok: true,
      value: {
        name: "story_authoring",
        description: "Author a new mystery.",
        tools: ["Read", "Write"],
      },
    });
  });

  it("reports a missing frontmatter block", () => {
    const result = parseSkillFrontmatterResult("no frontmatter here");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing-frontmatter");
  });

  it("reports a missing name", () => {
    const result = parseSkillFrontmatterResult(`---\ndescription: A skill.\n---`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing-name");
  });

  it("reports a missing description", () => {
    const result = parseSkillFrontmatterResult(`---\nname: only-name\n---`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing-description");
  });

  it("reports a name with whitespace and names the offending value", () => {
    const content = `---
name: Mystery Dinner — Story Authoring
description: Author a new mystery.
---
body`;
    const result = parseSkillFrontmatterResult(content);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("name-has-whitespace");
      expect(result.message).toContain("Mystery Dinner — Story Authoring");
    }
  });
});
