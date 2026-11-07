import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import * as pathsModule from "../paths.js" with { rstest: "importActual" };
import type { AgentConfig } from "../types.js";

const mockPaths = rs.hoisted(() => ({
  projectRoot: "/tmp/rome-test-project-root",
  profileDir: "/tmp/rome-test-profile",
  profileMemoryDir: "/tmp/rome-test-profile/memory",
  profileInstalledAppsDir: "/tmp/rome-test-profile/apps/installed",
  projectsRoot: "/tmp/rome-test-profile/projects",
  customAppAuthoringRoot: "/tmp/rome-test-profile/projects/apps",
}));

rs.mock("../paths.js", () => ({
  ...pathsModule,
  getProjectRoot: rs.fn(() => mockPaths.projectRoot),
  getProfileDir: rs.fn(() => mockPaths.profileDir),
  getProfileMemoryDir: rs.fn(() => mockPaths.profileMemoryDir),
  getProfileInstalledAppsDir: rs.fn(() => mockPaths.profileInstalledAppsDir),
  getProjectsRoot: rs.fn(() => mockPaths.projectsRoot),
  getCustomAppAuthoringRoot: rs.fn(() => mockPaths.customAppAuthoringRoot),
}));

import {
  buildInteractiveSurfaceGuidanceSection,
  PROJECT_SUMMARY_CHAR_LIMIT,
  PromptBuilder,
} from "./prompt-builder.js";

const mainConfig: AgentConfig = {
  name: "main",
  description: "Main test agent",
  tier: "large",
  reasoningEffort: "high",
  systemPromptPrefix: "You are the main test agent.",
  tools: [],
  permissionMode: "acceptEdits",
};

const corePromptOptions = { ownerType: "core" } as const;

describe("PromptBuilder", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-prompt-builder-"));
    mockPaths.projectRoot = join(root, "repo");
    mockPaths.profileDir = join(root, "profile");
    mockPaths.profileMemoryDir = join(mockPaths.profileDir, "memory");
    mockPaths.profileInstalledAppsDir = join(mockPaths.profileDir, "apps", "installed");
    mockPaths.projectsRoot = join(mockPaths.profileDir, "projects");
    mockPaths.customAppAuthoringRoot = join(mockPaths.projectsRoot, "apps");
  });

  afterEach(() => {
    rs.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("injects MEMORY.md fresh on each build", () => {
    mkdirSync(mockPaths.profileMemoryDir, { recursive: true });
    writeFileSync(
      join(mockPaths.profileMemoryDir, "MEMORY.md"),
      "# Memory\n\nOriginal guardian preference.",
    );

    const builder = new PromptBuilder();
    const initial = builder.build(mainConfig, corePromptOptions);

    expect(initial).toContain("# Memory");
    expect(initial).not.toContain("already loaded from `memory/MEMORY.md`");
    expect(initial).not.toContain("do not read `memory/MEMORY.md` again");
    expect(initial).toContain("Original guardian preference.");

    writeFileSync(
      join(mockPaths.profileMemoryDir, "MEMORY.md"),
      "# Memory\n\nUpdated guardian preference.",
    );

    const refreshed = builder.build(mainConfig, corePromptOptions);
    expect(refreshed).toContain("Updated guardian preference.");
    expect(refreshed).not.toContain("Original guardian preference.");
  });

  it("does not inject MEMORY.md into non-main agents", () => {
    mkdirSync(mockPaths.profileMemoryDir, { recursive: true });
    writeFileSync(
      join(mockPaths.profileMemoryDir, "MEMORY.md"),
      "# Memory\n\nPrivate guardian preference.",
    );

    const subAgentConfig: AgentConfig = {
      name: "envoy",
      description: "A non-main subagent",
      tier: "large",
      reasoningEffort: "high",
      systemPromptPrefix: "You are a subagent.",
      tools: [],
      permissionMode: "acceptEdits",
    };

    const prompt = new PromptBuilder().build(subAgentConfig, corePromptOptions);

    expect(prompt).not.toContain("# Memory");
    expect(prompt).not.toContain("Private guardian preference.");
  });

  it("injects MEMORY.md into a core agent whose policy loads memory", () => {
    mkdirSync(mockPaths.profileMemoryDir, { recursive: true });
    writeFileSync(
      join(mockPaths.profileMemoryDir, "MEMORY.md"),
      "# Memory\n\nShared guardian preference.",
    );

    const prompt = new PromptBuilder().build(
      { ...mainConfig, name: "concierge", policy: { loadMemory: true } },
      corePromptOptions,
    );

    expect(prompt).toContain("Shared guardian preference.");
    expect(prompt).toContain("# Runtime Context");
  });

  it("injects project context from PROJECT.md only", () => {
    const projectMemoryDir = join(mockPaths.profileMemoryDir, "projects", "alpha");
    mkdirSync(projectMemoryDir, { recursive: true });
    writeFileSync(
      join(projectMemoryDir, "PROJECT.md"),
      "# Alpha\n\nAlpha project first paragraph.\n\nDetails stay available on demand.",
    );
    writeFileSync(join(projectMemoryDir, "SUMMARY.md"), "Legacy summary should not load.");
    mkdirSync(join(mockPaths.projectsRoot, "alpha"), { recursive: true });

    const systemPrompt = new PromptBuilder().build(mainConfig, corePromptOptions);

    expect(systemPrompt).toContain("# Projects");
    expect(systemPrompt).toContain("Alpha project first paragraph.");
    expect(systemPrompt).toContain(join(mockPaths.projectsRoot, "alpha"));
    expect(systemPrompt).not.toContain("Details stay available on demand.");
    expect(systemPrompt).not.toContain("Legacy summary should not load.");
  });

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
  ])("bounds project context for $name without changing the file", ({ content, expected }) => {
    const projectMemoryDir = join(mockPaths.profileMemoryDir, "projects", "alpha");
    mkdirSync(projectMemoryDir, { recursive: true });
    const filePath = join(projectMemoryDir, "PROJECT.md");
    writeFileSync(filePath, content);
    mkdirSync(join(mockPaths.projectsRoot, "alpha"), { recursive: true });

    const prompt = new PromptBuilder().build(mainConfig, corePromptOptions);
    const projectSection = prompt.split("# Projects\n\n")[1];

    expect(projectSection).toBe(
      `- \`alpha\` (\`${join(mockPaths.projectsRoot, "alpha")}\`): ${expected}`,
    );
    expect(Array.from(expected).length).toBeLessThanOrEqual(PROJECT_SUMMARY_CHAR_LIMIT);
    expect(readFileSync(filePath, "utf8")).toBe(content);
  });

  it("points each project at a directory that exists, or at none", () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const dir = join(mockPaths.profileMemoryDir, "projects", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PROJECT.md"), `${name} introduction.`);
    }
    mkdirSync(join(mockPaths.projectsRoot, "alpha"), { recursive: true });
    mkdirSync(join(mockPaths.customAppAuthoringRoot, "beta"), { recursive: true });

    const projectSection = new PromptBuilder()
      .build(mainConfig, corePromptOptions)
      .split("# Projects\n\n")[1];

    expect(projectSection).toBe(
      [
        `- \`alpha\` (\`${join(mockPaths.projectsRoot, "alpha")}\`): alpha introduction.`,
        `- \`beta\` (\`${join(mockPaths.customAppAuthoringRoot, "beta")}\`): beta introduction.`,
        "- `gamma`: gamma introduction.",
      ].join("\n"),
    );
  });

  it("refreshes project introductions without injecting detailed notes", () => {
    const projectMemoryDir = join(mockPaths.profileMemoryDir, "projects", "alpha");
    mkdirSync(projectMemoryDir, { recursive: true });
    const filePath = join(projectMemoryDir, "PROJECT.md");
    writeFileSync(filePath, "# Alpha\n\nOriginal introduction.\n\n- Detailed history.");
    const builder = new PromptBuilder();
    expect(builder.build(mainConfig, corePromptOptions)).toContain("Original introduction.");

    writeFileSync(filePath, "# Alpha\n\nUpdated introduction.\n\n- Detailed history.");
    const refreshed = builder.build(mainConfig, corePromptOptions);

    expect(refreshed).toContain("Updated introduction.");
    expect(refreshed).not.toContain("Original introduction.");
    expect(refreshed).not.toContain("Detailed history.");
    expect(builder.build({ ...mainConfig, name: "envoy" }, corePromptOptions)).not.toContain(
      "# Projects",
    );
    expect(builder.build(mainConfig, { ownerType: "app" })).not.toContain("# Projects");
  });

  it("includes local dashboard and app URLs in the agent browser guidance", () => {
    const systemPrompt = new PromptBuilder().build(mainConfig, corePromptOptions);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).toContain("Agent browser:");
    expect(systemPrompt).toContain("`http://127.0.0.1:4141` to open the Rome dashboard");
    expect(systemPrompt).toContain("`http://127.0.0.1:4141/apps/<appId>` to use a specific app");
  });

  it("points the main agent at Rome's docs for questions about Rome itself", () => {
    const docsDir = join(mockPaths.projectRoot, "docs");
    mkdirSync(docsDir, { recursive: true });

    const systemPrompt = new PromptBuilder().build(mainConfig, corePromptOptions);

    expect(systemPrompt).toContain(
      `Rome's docs are in \`${docsDir}\`. Search them before answering whether Rome supports something.`,
    );
  });

  it("omits the docs pointer when the docs did not ship", () => {
    const systemPrompt = new PromptBuilder().build(mainConfig, corePromptOptions);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).not.toContain("Rome's docs are in");
  });

  it("asks guardian-facing agents to state a short plan before long-running work", () => {
    const prompt = new PromptBuilder().build({ ...mainConfig, actions: ["*"] }, corePromptOptions);
    // Cut at the next top-level heading so the checks stay inside this section.
    const section = prompt.split("# Asking The Guardian For Input\n\n")[1]?.split("\n# ")[0] ?? "";
    const planIndex = section.indexOf("Before you start a long-running task");

    expect(planIndex).toBeGreaterThan(-1);
    expect(section).toContain("state your plan, then start without waiting for approval");
    expect(section).toContain("ASD-STE100 Simplified Technical English");
    expect(section).toContain(
      "If you already show the plan as a todo list, do not repeat it in prose.",
    );
    // The plan paragraph sits before the "use the ask_question tool" rule.
    expect(planIndex).toBeLessThan(section.indexOf("When you do need to ask"));

    const withoutAskTool = new PromptBuilder().build(mainConfig, corePromptOptions);
    expect(withoutAskTool).not.toContain("Before you start a long-running task");
  });

  it("advertises the globally available Discord CLI to every agent", () => {
    const subAgentConfig: AgentConfig = {
      ...mainConfig,
      name: "envoy",
      systemPromptPrefix: "You are a subagent.",
    };

    for (const config of [mainConfig, subAgentConfig]) {
      const systemPrompt = new PromptBuilder().build(config, corePromptOptions);
      expect(systemPrompt).toContain("# Command Line Tools");
      expect(systemPrompt).toContain("A global `discord` CLI is available");
      expect(systemPrompt).toContain("prefer `discord api` over memory");
      expect(systemPrompt).toContain("Run `discord api --help` when needed");
    }
  });

  it("keeps Mermaid guidance out of the cached global prompt", () => {
    const systemPrompt = new PromptBuilder().build(mainConfig, corePromptOptions);

    expect(systemPrompt).not.toContain("```mermaid");
    expect(systemPrompt).not.toContain("Mermaid fenced code blocks");
  });

  it("builds Mermaid guidance as an interactive-surface-only section", () => {
    const guidance = buildInteractiveSurfaceGuidanceSection();

    expect(guidance).toContain("# Diagrams");
    expect(guidance).toContain("```mermaid");
    expect(guidance).toContain("interactive SVG diagrams");
  });

  it("honours INTERNAL_API_PORT in the agent browser guidance", () => {
    rs.stubEnv("INTERNAL_API_PORT", "9999");

    const systemPrompt = new PromptBuilder().build(mainConfig, corePromptOptions);

    expect(systemPrompt).toContain("`http://127.0.0.1:9999` to open the Rome dashboard");
    expect(systemPrompt).toContain("`http://127.0.0.1:9999/apps/<appId>` to use a specific app");
  });

  it("surfaces Rome's own email address in the main-agent runtime context", () => {
    const systemPrompt = new PromptBuilder(undefined, () => "rome-abc@romeos.cc").build(
      mainConfig,
      corePromptOptions,
    );

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).toContain("Your email address:");
    expect(systemPrompt).toContain("`rome-abc@romeos.cc`");
  });

  it("omits the email line when no address is provisioned", () => {
    const undefinedAddr = new PromptBuilder(undefined, () => undefined).build(
      mainConfig,
      corePromptOptions,
    );
    expect(undefinedAddr).toContain("# Runtime Context");
    expect(undefinedAddr).not.toContain("Your email address:");

    const blankAddr = new PromptBuilder(undefined, () => "   ").build(
      mainConfig,
      corePromptOptions,
    );
    expect(blankAddr).not.toContain("Your email address:");

    // No getter at all (default wiring before an email adapter exists).
    expect(new PromptBuilder().build(mainConfig, corePromptOptions)).not.toContain(
      "Your email address:",
    );
  });

  it("surfaces Rome's own public web address in the main-agent runtime context", () => {
    const systemPrompt = new PromptBuilder(
      undefined,
      undefined,
      () => "https://acme.romeos.cc",
    ).build(mainConfig, corePromptOptions);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).toContain("Your public web address is `https://acme.romeos.cc`");
  });

  it("omits the public web address line when the instance has no public domain", () => {
    const undefinedOrigin = new PromptBuilder(undefined, undefined, () => undefined).build(
      mainConfig,
      corePromptOptions,
    );
    expect(undefinedOrigin).toContain("# Runtime Context");
    expect(undefinedOrigin).not.toContain("Your public web address");

    const blankOrigin = new PromptBuilder(undefined, undefined, () => "   ").build(
      mainConfig,
      corePromptOptions,
    );
    expect(blankOrigin).not.toContain("Your public web address");
  });

  it("does not leak Rome's email address into non-main agents", () => {
    const subAgentConfig: AgentConfig = {
      name: "envoy",
      description: "A non-main subagent",
      tier: "large",
      reasoningEffort: "high",
      systemPromptPrefix: "You are a subagent.",
      tools: [],
      permissionMode: "acceptEdits",
    };

    const prompt = new PromptBuilder(undefined, () => "rome-abc@romeos.cc").build(
      subAgentConfig,
      corePromptOptions,
    );
    expect(prompt).not.toContain("# Runtime Context");
    expect(prompt).not.toContain("Your email address:");
  });

  it("drops a disabled app from '# Installed Apps' only after the prefix cache is invalidated", () => {
    // Stand in for AppCatalog.listResolved(): it already filters disabled apps,
    // so disabling one just removes it from the returned array. The bug this
    // guards is the *prefix cache* — the section is computed once and reused, so
    // a runtime change is invisible until the cache is dropped (the catalog
    // subscriber wired in index.ts calls invalidateAll() on every change).
    let resolved = [
      { appId: "weather", manifest: { description: "Weather lookups" } },
      { appId: "notes", manifest: { description: "Quick notes" } },
    ];
    const appCatalog = {
      listResolved: () => resolved,
    } as unknown as ConstructorParameters<typeof PromptBuilder>[0];

    const builder = new PromptBuilder(appCatalog);

    const initial = builder.build(mainConfig, corePromptOptions);
    expect(initial).toContain("# Installed Apps");
    expect(initial).toContain("- `weather`: Weather lookups");
    expect(initial).toContain("- `notes`: Quick notes");

    // Disable `notes`. Without invalidation the cached prefix still lists it.
    resolved = [{ appId: "weather", manifest: { description: "Weather lookups" } }];
    expect(builder.build(mainConfig, corePromptOptions)).toContain("- `notes`: Quick notes");

    builder.invalidateAll();
    const refreshed = builder.build(mainConfig, corePromptOptions);
    expect(refreshed).toContain("- `weather`: Weather lookups");
    expect(refreshed).not.toContain("- `notes`: Quick notes");
  });

  it("lists '# Installed Apps' for core subagents too, not just main", () => {
    const appCatalog = {
      listResolved: () => [
        {
          appId: "connector",
          manifest: { description: "Connect third-party APIs via connector_proxy" },
        },
      ],
    } as unknown as ConstructorParameters<typeof PromptBuilder>[0];

    const subAgentConfig: AgentConfig = {
      name: "envoy",
      description: "A non-main subagent",
      tier: "large",
      reasoningEffort: "high",
      systemPromptPrefix: "You are a subagent.",
      tools: [],
      permissionMode: "acceptEdits",
    };

    const prompt = new PromptBuilder(appCatalog).build(subAgentConfig, corePromptOptions);

    // The connector catalog lives in the connector app's description, surfaced
    // here — so a subagent must see this section even though it gets no
    // main-only "# Runtime Context" block.
    expect(prompt).not.toContain("# Runtime Context");
    expect(prompt).toContain("# Installed Apps");
    expect(prompt).toContain("- `connector`: Connect third-party APIs via connector_proxy");
  });

  it("lets app-owned agents fully control their base prompt", () => {
    mkdirSync(mockPaths.profileMemoryDir, { recursive: true });
    writeFileSync(join(mockPaths.profileMemoryDir, "IDENTITY.md"), "Guardian identity");

    const appCatalog = {
      listResolved: () => [
        { appId: "connector", manifest: { description: "Platform connector catalog" } },
      ],
    } as unknown as ConstructorParameters<typeof PromptBuilder>[0];
    const appConfig: AgentConfig = {
      ...mainConfig,
      name: "app-assistant",
      systemPromptPrefix: "You are the app's custom assistant.",
      actions: ["*"],
    };

    const prompt = new PromptBuilder(appCatalog).build(appConfig, {
      ownerType: "app",
      contextSuffix: "App-supplied session context.",
    });

    expect(prompt).toBe("You are the app's custom assistant.\n\nApp-supplied session context.");
    expect(prompt).not.toContain("# Charter");
    expect(prompt).not.toContain("# Identity");
    expect(prompt).not.toContain("# Asking The Guardian For Input");
    expect(prompt).not.toContain("# Command Line Tools");
    expect(prompt).not.toContain("# Installed Apps");
  });
});
