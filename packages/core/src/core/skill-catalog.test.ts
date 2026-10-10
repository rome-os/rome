import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "@rstest/core";
import {
  listCompanionFiles,
  parseSkillFrontmatter,
  parseSkillFrontmatterResult,
} from "./skill-catalog.js";

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

describe("listCompanionFiles", () => {
  it("lists every file beside SKILL.md, sorted, with nested paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-companions-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "---\nname: a\ndescription: b\n---");
      await writeFile(join(dir, "SHARING.md"), "x");
      await writeFile(join(dir, "PUBLISHING.md"), "x");
      await mkdir(join(dir, "music"));
      await writeFile(join(dir, "music", "track.md"), "x");
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x");

      expect(await listCompanionFiles(dir)).toEqual([
        "PUBLISHING.md",
        "SHARING.md",
        "music/track.md",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for a SKILL.md-only or missing directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-companions-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "x");
      expect(await listCompanionFiles(dir)).toEqual([]);
      expect(await listCompanionFiles(join(dir, "missing"))).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
