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

import { createTestSystemPrompts } from "./system-prompts.js";

const mainConfig: AgentConfig = {
  name: "main",
  description: "Main test agent",
  tier: "large",
  reasoningEffort: "high",
  systemPromptPrefix: "You are the main test agent.",
  tools: [],
  permissionMode: "acceptEdits",
};

type TestApps = NonNullable<Parameters<typeof createTestSystemPrompts>[0]>["apps"];

const plainText = { widgets: "plain_text" } as const;

function core(config: AgentConfig) {
  return { ...config, owner: "core" } as const;
}

describe("the system prompt", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rome-system-prompt-"));
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

    const builder = createTestSystemPrompts();
    const initial = builder.build(core(mainConfig), plainText);

    expect(initial).toContain("# Memory");
    expect(initial).not.toContain("already loaded from `memory/MEMORY.md`");
    expect(initial).not.toContain("do not read `memory/MEMORY.md` again");
    expect(initial).toContain("Original guardian preference.");

    writeFileSync(
      join(mockPaths.profileMemoryDir, "MEMORY.md"),
      "# Memory\n\nUpdated guardian preference.",
    );

    const refreshed = builder.build(core(mainConfig), plainText);
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

    const prompt = createTestSystemPrompts().build(core(subAgentConfig), plainText);

    expect(prompt).not.toContain("# Memory");
    expect(prompt).not.toContain("Private guardian preference.");
  });

  it("injects MEMORY.md into a core agent whose policy loads memory", () => {
    mkdirSync(mockPaths.profileMemoryDir, { recursive: true });
    writeFileSync(
      join(mockPaths.profileMemoryDir, "MEMORY.md"),
      "# Memory\n\nShared guardian preference.",
    );

    const prompt = createTestSystemPrompts().build(
      core({ ...mainConfig, name: "concierge", policy: { loadMemory: true } }),
      plainText,
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

    const systemPrompt = createTestSystemPrompts().build(core(mainConfig), plainText);

    expect(systemPrompt).toContain("# Projects");
    expect(systemPrompt).toContain("Alpha project first paragraph.");
    expect(systemPrompt).toContain(join(mockPaths.projectsRoot, "alpha"));
    expect(systemPrompt).not.toContain("Details stay available on demand.");
    expect(systemPrompt).not.toContain("Legacy summary should not load.");
  });

  it("points each project at a directory that exists, or at none", () => {
    for (const name of ["alpha", "beta", "gamma"]) {
      const dir = join(mockPaths.profileMemoryDir, "projects", name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "PROJECT.md"), `${name} introduction.`);
    }
    mkdirSync(join(mockPaths.projectsRoot, "alpha"), { recursive: true });
    mkdirSync(join(mockPaths.customAppAuthoringRoot, "beta"), { recursive: true });

    const projectSection = createTestSystemPrompts()
      .build(core(mainConfig), plainText)
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
    const builder = createTestSystemPrompts();
    expect(builder.build(core(mainConfig), plainText)).toContain("Original introduction.");

    writeFileSync(filePath, "# Alpha\n\nUpdated introduction.\n\n- Detailed history.");
    const refreshed = builder.build(core(mainConfig), plainText);

    expect(refreshed).toContain("Updated introduction.");
    expect(refreshed).not.toContain("Original introduction.");
    expect(refreshed).not.toContain("Detailed history.");
    expect(builder.build(core({ ...mainConfig, name: "envoy" }), plainText)).not.toContain(
      "# Projects",
    );
    expect(builder.build({ ...mainConfig, owner: "app" }, plainText)).not.toContain("# Projects");
  });

  it("includes local dashboard and app URLs in the agent browser guidance", () => {
    const systemPrompt = createTestSystemPrompts().build(core(mainConfig), plainText);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).toContain("Agent browser:");
    expect(systemPrompt).toContain("`http://127.0.0.1:4141` to open the Rome dashboard");
    expect(systemPrompt).toContain("`http://127.0.0.1:4141/apps/<appId>` to use a specific app");
  });

  it("points the main agent at Rome's docs for questions about Rome itself", () => {
    const docsDir = join(mockPaths.projectRoot, "docs");
    mkdirSync(docsDir, { recursive: true });

    const systemPrompt = createTestSystemPrompts().build(core(mainConfig), plainText);

    expect(systemPrompt).toContain(
      `Rome's docs are in \`${docsDir}\`. Search them before answering whether Rome supports something.`,
    );
  });

  it("omits the docs pointer when the docs did not ship", () => {
    const systemPrompt = createTestSystemPrompts().build(core(mainConfig), plainText);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).not.toContain("Rome's docs are in");
  });

  it("asks guardian-facing agents to state a short plan before long-running work", () => {
    const prompt = createTestSystemPrompts().build(
      core({ ...mainConfig, actions: ["*"] }),
      plainText,
    );
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

    const withoutAskTool = createTestSystemPrompts().build(core(mainConfig), plainText);
    expect(withoutAskTool).not.toContain("Before you start a long-running task");
  });

  it("advertises the globally available Discord CLI to every agent", () => {
    const subAgentConfig: AgentConfig = {
      ...mainConfig,
      name: "envoy",
      systemPromptPrefix: "You are a subagent.",
    };

    for (const config of [mainConfig, subAgentConfig]) {
      const systemPrompt = createTestSystemPrompts().build(core(config), plainText);
      expect(systemPrompt).toContain("# Command Line Tools");
      expect(systemPrompt).toContain("A global `discord` CLI is available");
      expect(systemPrompt).toContain("prefer `discord api` over memory");
      expect(systemPrompt).toContain("Run `discord api --help` when needed");
    }
  });

  it("keeps Mermaid guidance out of the cached global prompt", () => {
    const systemPrompt = createTestSystemPrompts().build(core(mainConfig), plainText);

    expect(systemPrompt).not.toContain("```mermaid");
    expect(systemPrompt).not.toContain("Mermaid fenced code blocks");
  });

  it("honours INTERNAL_API_PORT in the agent browser guidance", () => {
    rs.stubEnv("INTERNAL_API_PORT", "9999");

    const systemPrompt = createTestSystemPrompts().build(core(mainConfig), plainText);

    expect(systemPrompt).toContain("`http://127.0.0.1:9999` to open the Rome dashboard");
    expect(systemPrompt).toContain("`http://127.0.0.1:9999/apps/<appId>` to use a specific app");
  });

  it("surfaces Rome's own email address in the main-agent runtime context", () => {
    const systemPrompt = createTestSystemPrompts({
      emailAddress: () => "rome-abc@romeos.cc",
    }).build(core(mainConfig), plainText);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).toContain("Your email address:");
    expect(systemPrompt).toContain("`rome-abc@romeos.cc`");
  });

  it("omits the email line when no address is provisioned", () => {
    const undefinedAddr = createTestSystemPrompts({ emailAddress: () => undefined }).build(
      core(mainConfig),
      plainText,
    );
    expect(undefinedAddr).toContain("# Runtime Context");
    expect(undefinedAddr).not.toContain("Your email address:");

    const blankAddr = createTestSystemPrompts({ emailAddress: () => "   " }).build(
      core(mainConfig),
      plainText,
    );
    expect(blankAddr).not.toContain("Your email address:");

    // No getter at all (default wiring before an email adapter exists).
    expect(createTestSystemPrompts().build(core(mainConfig), plainText)).not.toContain(
      "Your email address:",
    );
  });

  it("surfaces Rome's own public web address in the main-agent runtime context", () => {
    const systemPrompt = createTestSystemPrompts({
      publicOrigin: () => "https://acme.romeos.cc",
    }).build(core(mainConfig), plainText);

    expect(systemPrompt).toContain("# Runtime Context");
    expect(systemPrompt).toContain("Your public web address is `https://acme.romeos.cc`");
  });

  it("omits the public web address line when the instance has no public domain", () => {
    const undefinedOrigin = createTestSystemPrompts({ publicOrigin: () => undefined }).build(
      core(mainConfig),
      plainText,
    );
    expect(undefinedOrigin).toContain("# Runtime Context");
    expect(undefinedOrigin).not.toContain("Your public web address");

    const blankOrigin = createTestSystemPrompts({ publicOrigin: () => "   " }).build(
      core(mainConfig),
      plainText,
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

    const prompt = createTestSystemPrompts({ emailAddress: () => "rome-abc@romeos.cc" }).build(
      core(subAgentConfig),
      plainText,
    );
    expect(prompt).not.toContain("# Runtime Context");
    expect(prompt).not.toContain("Your email address:");
  });

  it("drops a disabled app from '# Installed Apps' once the catalog says it changed", () => {
    // Stand in for AppCatalog.listResolved(): it already filters disabled apps,
    // so disabling one just removes it from the returned array. The fixed part
    // is held and reused, so a runtime change is invisible until the catalog's
    // event drops it.
    let resolved = [
      { appId: "weather", manifest: { description: "Weather lookups" } },
      { appId: "notes", manifest: { description: "Quick notes" } },
    ];
    let appChanged = () => {};
    const appCatalog = {
      listResolved: () => resolved,
      subscribe: (handler: () => void) => {
        appChanged = handler;
        return () => {};
      },
    } as unknown as TestApps;

    const builder = createTestSystemPrompts({ apps: appCatalog });

    const initial = builder.build(core(mainConfig), plainText);
    expect(initial).toContain("# Installed Apps");
    expect(initial).toContain("- `weather`: Weather lookups");
    expect(initial).toContain("- `notes`: Quick notes");

    // Disable `notes`. Until the event, the held fixed part still lists it.
    resolved = [{ appId: "weather", manifest: { description: "Weather lookups" } }];
    expect(builder.build(core(mainConfig), plainText)).toContain("- `notes`: Quick notes");

    appChanged();
    const refreshed = builder.build(core(mainConfig), plainText);
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
      subscribe: () => () => {},
    } as unknown as TestApps;

    const subAgentConfig: AgentConfig = {
      name: "envoy",
      description: "A non-main subagent",
      tier: "large",
      reasoningEffort: "high",
      systemPromptPrefix: "You are a subagent.",
      tools: [],
      permissionMode: "acceptEdits",
    };

    const prompt = createTestSystemPrompts({ apps: appCatalog }).build(
      core(subAgentConfig),
      plainText,
    );

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
      subscribe: () => () => {},
    } as unknown as TestApps;
    const appConfig: AgentConfig = {
      ...mainConfig,
      name: "app-assistant",
      systemPromptPrefix: "You are the app's custom assistant.",
      actions: ["*"],
    };

    const prompt = createTestSystemPrompts({ apps: appCatalog }).build(
      { ...appConfig, owner: "app" },
      { contextSuffix: "App-supplied session context.", widgets: "plain_text" },
    );

    expect(prompt).toBe("You are the app's custom assistant.\n\nApp-supplied session context.");
    expect(prompt).not.toContain("# Charter");
    expect(prompt).not.toContain("# Identity");
    expect(prompt).not.toContain("# Asking The Guardian For Input");
    expect(prompt).not.toContain("# Command Line Tools");
    expect(prompt).not.toContain("# Installed Apps");
  });
});
