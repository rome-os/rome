import { describe, expect, it } from "@rstest/core";
import {
  buildPromptPrefix,
  buildSystemPrompt,
  carriesMemory,
  PROJECT_SUMMARY_CHAR_LIMIT,
  projectSummary,
  type PromptAgent,
  type PromptMaterial,
} from "./system-prompt.js";

const agent: PromptAgent = { name: "main", owner: "core", systemPromptPrefix: "You are main." };

const material: PromptMaterial = {
  charter: "The charter.",
  identity: "The identity.",
  runtime: {
    profileDir: "/profile",
    profileMemoryDir: "/profile/memory",
    customAppAuthoringDir: "/profile/projects/apps",
    installedAppsDir: "/profile/apps/installed",
    repoAppsDir: "/repo/rome_apps",
    internalApiBaseUrl: "http://127.0.0.1:4141",
    docsDir: null,
  },
  installedApps: [{ appId: "weather", description: "Weather lookups" }],
};

describe("buildPromptPrefix", () => {
  it("gives an app's agent only its declared prompt", () => {
    const prefix = buildPromptPrefix(
      { ...agent, owner: "app", systemPromptPrefix: "  Declared.  ", actions: ["*"] },
      material,
    );
    expect(prefix).toBe("Declared.");
  });

  it("puts the asking guidance inside the block of a core agent with the `*` grant", () => {
    const prefix = buildPromptPrefix({ ...agent, actions: ["*"] }, material);
    expect(prefix.startsWith("You are main.\n\n# Asking The Guardian For Input")).toBe(true);
    expect(buildPromptPrefix(agent, material)).not.toContain("# Asking The Guardian For Input");
  });

  it("orders a core agent's sections with a divider between them", () => {
    const headings = buildPromptPrefix(agent, material)
      .split("\n\n---\n\n")
      .map((section) => section.split("\n")[0]);
    expect(headings).toEqual([
      "You are main.",
      "# Charter",
      "# Identity",
      "# Runtime Context",
      "# Command Line Tools",
      "# Installed Apps",
    ]);
  });

  it("gives runtime context only to an agent whose policy loads memory", () => {
    const prefix = buildPromptPrefix({ ...agent, name: "envoy" }, material);
    expect(prefix).not.toContain("# Runtime Context");
    expect(prefix).toContain("# Installed Apps");
  });

  it("leaves a heading the identity already has", () => {
    const prefix = buildPromptPrefix(agent, { ...material, identity: "# identity\n\nMine." });
    expect(prefix).toContain("# identity\n\nMine.");
    expect(prefix).not.toContain("# Identity");
  });
});

describe("carriesMemory", () => {
  it("follows a core agent's policy", () => {
    expect(carriesMemory(agent)).toBe(true);
    expect(carriesMemory({ ...agent, name: "envoy" })).toBe(false);
    expect(carriesMemory({ ...agent, name: "envoy", policy: { loadMemory: true } })).toBe(true);
  });

  it("is never true for an app's agent", () => {
    expect(carriesMemory({ ...agent, owner: "app", policy: { loadMemory: true } })).toBe(false);
  });
});

describe("buildSystemPrompt", () => {
  const memory = {
    index: "Remember this.",
    projects: [
      { name: "alpha", location: "/projects/alpha", summary: "Alpha." },
      { name: "beta", location: null, summary: "Beta." },
    ],
  };

  it("joins memory, projects and the suffix with a blank line, in that order", () => {
    const prompt = buildSystemPrompt({
      prefix: "Fixed.",
      owner: "core",
      memory,
      contextSuffix: "Suffix.",
      widgets: "plain_text",
    });
    expect(prompt).toBe(
      [
        "Fixed.",
        "# Memory\n\nRemember this.",
        "# Projects\n\n- `alpha` (`/projects/alpha`): Alpha.\n- `beta`: Beta.",
        "Suffix.",
      ].join("\n\n"),
    );
  });

  it("adds no section for memory that has nothing in it", () => {
    const prompt = buildSystemPrompt({
      prefix: "Fixed.",
      owner: "core",
      memory: { index: null, projects: [] },
      widgets: "plain_text",
    });
    expect(prompt).toBe("Fixed.");
  });

  it("gives a core agent diagrams last, after a divider, where widgets are cards", () => {
    const prompt = buildSystemPrompt({
      prefix: "Fixed.",
      owner: "core",
      memory: null,
      contextSuffix: "Suffix.",
      widgets: "card",
    });
    expect(prompt.startsWith("Fixed.\n\nSuffix.\n\n---\n\n# Diagrams\n\n")).toBe(true);
    expect(prompt).toContain("```mermaid");
  });

  it("gives diagrams to no app's agent and to nothing that draws plain text", () => {
    const input = { prefix: "Fixed.", memory: null };
    expect(buildSystemPrompt({ ...input, owner: "app", widgets: "card" })).toBe("Fixed.");
    expect(buildSystemPrompt({ ...input, owner: "core", widgets: "plain_text" })).toBe("Fixed.");
  });
});

describe("projectSummary", () => {
  it.each([
    {
      name: "wrapped prose with CRLF and heading-only blocks",
      content:
        "# Alpha\r\n\r\n## Summary\r\n\r\nA short\r\nproject introduction.\r\n\r\nPrivate implementation details.",
      expected: "A short project introduction.",
    },
    {
      name: "an exact-limit paragraph",
      content: "a".repeat(PROJECT_SUMMARY_CHAR_LIMIT),
      expected: "a".repeat(PROJECT_SUMMARY_CHAR_LIMIT),
    },
    {
      name: "an oversized prose paragraph",
      content: "a".repeat(PROJECT_SUMMARY_CHAR_LIMIT + 1),
      expected: `${"a".repeat(PROJECT_SUMMARY_CHAR_LIMIT - 1)}…`,
    },
    {
      name: "consecutive bullets without blank lines",
      content: `# Alpha\n\n${"- Release details\n".repeat(100)}\nPrivate implementation details.`,
      expected: `${Array(100)
        .fill("- Release details")
        .join(" ")
        .slice(0, PROJECT_SUMMARY_CHAR_LIMIT - 1)
        .trimEnd()}…`,
    },
    {
      name: "non-BMP characters at the truncation boundary",
      content: "🌸".repeat(PROJECT_SUMMARY_CHAR_LIMIT + 1),
      expected: `${"🌸".repeat(PROJECT_SUMMARY_CHAR_LIMIT - 1)}…`,
    },
  ])("bounds $name", ({ content, expected }) => {
    expect(projectSummary(content)).toBe(expected);
    expect(Array.from(expected).length).toBeLessThanOrEqual(PROJECT_SUMMARY_CHAR_LIMIT);
  });

  it("is null when the file has only headings", () => {
    expect(projectSummary("# Alpha\n\n## Notes")).toBeNull();
  });
});
