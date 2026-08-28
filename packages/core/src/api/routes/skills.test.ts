import { describe, it, expect } from "@rstest/core";
import { Hono } from "hono";
import { skillsRoutes } from "./skills.js";
import { createTestDb, buildTestDeps } from "../../test/helpers.js";
import type { LoadedSkill } from "../../core/skill-catalog.js";

function loadedSkill(overrides: Partial<LoadedSkill> & { name: string }): LoadedSkill {
  return {
    metadata: {
      kind: "skill",
      ownerType: "app",
      ownerId: "coding",
      publicName: overrides.name,
      sourcePath: `/installed/coding/skills/${overrides.name}`,
    },
    description: "A test skill",
    content: "---\n---\nbody",
    ...overrides,
  } as LoadedSkill;
}

describe("GET /skills", () => {
  it("returns an empty list when the catalog has no skills", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const app = new Hono().route("/", skillsRoutes(deps));

      const res = await app.request("/skills");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ skills: [], loadFailures: [] });
    } finally {
      testDb.close();
    }
  });

  it("returns catalog metadata without skill bodies", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const skillCatalog = {
        get: () => undefined,
        getAll: () => [
          loadedSkill({
            name: "app_creation",
            description: "Scaffold a new Rome app",
            tools: ["Read", "Edit", "Bash"],
          }),
          loadedSkill({ name: "skill-import" }),
        ],
        getRegistryLoadFailures: () => [],
      };
      const app = new Hono().route("/", skillsRoutes({ ...deps, skillCatalog }));

      const res = await app.request("/skills");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        skills: [
          {
            name: "app_creation",
            description: "Scaffold a new Rome app",
            tools: ["Read", "Edit", "Bash"],
            ownerType: "app",
            ownerId: "coding",
            ownerLabel: "coding",
            ownerDescription: "",
            iconUrl: null,
          },
          {
            name: "skill-import",
            description: "A test skill",
            tools: [],
            ownerType: "app",
            ownerId: "coding",
            ownerLabel: "coding",
            ownerDescription: "",
            iconUrl: null,
          },
        ],
        loadFailures: [],
      });
    } finally {
      testDb.close();
    }
  });

  it("encodes scoped owner ids in loaded and failed skill icon URLs", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const ownerId = "@foo/bar";
      const skillCatalog = {
        get: () => undefined,
        getAll: () => [
          loadedSkill({
            name: `${ownerId}:baz`,
            localName: "baz",
            metadata: {
              kind: "skill",
              ownerType: "app",
              ownerId,
              publicName: "baz",
              aliases: [],
              sourcePath: "/installed/%40foo%2Fbar/skills/baz",
            },
          }),
        ],
        getRegistryLoadFailures: () => [
          {
            kind: "skill" as const,
            ownerId,
            publicName: "broken",
            sourcePath: "/installed/%40foo%2Fbar/skills/broken",
            error: "invalid frontmatter",
          },
        ],
      };
      const appCatalog = {
        listResolved: () => [
          {
            appId: ownerId,
            displayName: "Scoped app",
            iconAbsolutePath: "/installed/%40foo%2Fbar/icon.png",
            manifest: { description: "Scoped app description" },
          },
        ],
      } as unknown as typeof deps.appCatalog;
      const app = new Hono().route("/", skillsRoutes({ ...deps, appCatalog, skillCatalog }));

      const res = await app.request("/skills");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        skills: Array<{ iconUrl: string | null }>;
        loadFailures: Array<{ iconUrl: string | null }>;
      };
      expect(body.skills[0]?.iconUrl).toBe("/api/apps/%40foo%2Fbar/icon");
      expect(body.loadFailures[0]?.iconUrl).toBe("/api/apps/%40foo%2Fbar/icon");
    } finally {
      testDb.close();
    }
  });

  it("surfaces app-owned skills that were declared but failed to load", async () => {
    const testDb = createTestDb();
    try {
      const deps = await buildTestDeps(testDb.db);
      const skillCatalog = {
        get: () => undefined,
        getAll: () => [],
        getRegistryLoadFailures: () => [
          {
            kind: "skill" as const,
            ownerId: "jubensha",
            publicName: "story_authoring",
            sourcePath: "/installed/jubensha/skills/story_authoring",
            error:
              'Skill /installed/jubensha/skills/story_authoring/SKILL.md has invalid frontmatter: name must be a single token with no whitespace (got "Mystery Dinner — Story Authoring")',
          },
        ],
      };
      const app = new Hono().route("/", skillsRoutes({ ...deps, skillCatalog }));

      const res = await app.request("/skills");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        skills: [],
        loadFailures: [
          {
            publicName: "story_authoring",
            ownerId: "jubensha",
            ownerLabel: "jubensha",
            sourcePath: "/installed/jubensha/skills/story_authoring",
            error:
              'Skill /installed/jubensha/skills/story_authoring/SKILL.md has invalid frontmatter: name must be a single token with no whitespace (got "Mystery Dinner — Story Authoring")',
            iconUrl: null,
          },
        ],
      });
    } finally {
      testDb.close();
    }
  });
});
