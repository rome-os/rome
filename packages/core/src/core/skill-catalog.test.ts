import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "@rstest/core";
import type { AppCatalog } from "../apps/catalog.js";
import { createEmptyLegacyArtifactBindings, type ArtifactId } from "../apps/artifact-id.js";
import type { ArtifactRef } from "../apps/state.js";
import { buildFacadeBundle } from "./mcp-facade.js";
import {
  listCompanionFiles,
  parseSkillFrontmatter,
  parseSkillFrontmatterResult,
  SkillCatalog,
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
  it("lists every visible file beside SKILL.md, sorted, with nested paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-companions-"));
    try {
      await writeFile(join(dir, "SKILL.md"), "---\nname: a\ndescription: b\n---");
      await writeFile(join(dir, "SHARING.md"), "x");
      await writeFile(join(dir, "PUBLISHING.md"), "x");
      await mkdir(join(dir, "music"));
      await writeFile(join(dir, "music", "track.md"), "x");
      await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
      await writeFile(join(dir, "node_modules", "pkg", "index.js"), "x");
      await writeFile(join(dir, ".env"), "SECRET=x");
      await mkdir(join(dir, ".git"));
      await writeFile(join(dir, ".git", "HEAD"), "x");

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

describe("SkillCatalog.getMcpDefinitions", () => {
  async function writeSkill(root: string, dir: string, name: string): Promise<string> {
    const skillDir = join(root, dir);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody`);
    return skillDir;
  }

  function catalogOf(refs: ArtifactRef[]): AppCatalog {
    return {
      listArtifacts: (kind: string) => refs.filter((ref) => ref.kind === kind),
    } as unknown as AppCatalog;
  }

  it("carries bound bare names as legacyNames, which read_skill accepts", async () => {
    const root = await mkdtemp(join(tmpdir(), "skill-legacy-names-"));
    try {
      const identity = { legacyBindings: createEmptyLegacyArtifactBindings() };
      const skills = new SkillCatalog(identity);
      await skills.loadFromCatalog(
        catalogOf([
          {
            formatVersion: 1,
            kind: "skill",
            publicName: "foo-dir",
            aliases: [],
            ownerType: "app",
            ownerId: "bar",
            absolutePath: await writeSkill(root, "foo-dir", "foo"),
          },
          {
            formatVersion: 2,
            kind: "skill",
            publicName: "qux",
            aliases: [],
            ownerType: "app",
            ownerId: "baz",
            absolutePath: await writeSkill(root, "qux", "qux"),
          },
        ]),
      );

      const byName = new Map(skills.getMcpDefinitions().map((skill) => [skill.name, skill]));
      expect(byName.get("bar:foo")?.legacyNames).toEqual(["foo", "foo-dir"]);
      expect(byName.get("baz:qux")).not.toHaveProperty("legacyNames");

      const readSkill = buildFacadeBundle({
        getActionCatalog: () => [],
        getSkillCatalog: () => skills.getMcpDefinitions(),
        subagentTools: [],
        executeAction: async () => ({}),
        executeSubagent: async () => ({}),
      }).skills.find((tool) => tool.name === "read_skill")!;
      const read = await readSkill.handler({ skill_name: "foo" });
      expect(read.isError).toBeUndefined();
      expect(JSON.parse(read.content[0].text)).toMatchObject({ name: "bar:foo" });

      // Bindings persist, so a name bound while an app was format version 1
      // still resolves after the app moves to version 2.
      identity.legacyBindings.skill.qux = "baz:qux" as ArtifactId;
      const refreshed = skills.getMcpDefinitions().find((skill) => skill.name === "baz:qux");
      expect(refreshed?.legacyNames).toEqual(["qux"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
