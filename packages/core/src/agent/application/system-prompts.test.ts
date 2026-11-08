import { describe, expect, it } from "@rstest/core";
import type {
  PromptAgent,
  PromptMaterial,
  PromptMemory,
  PromptSources,
} from "../domain/system-prompt.js";
import { createSystemPrompts } from "./system-prompts.js";

const agent: PromptAgent = { name: "main", owner: "core", systemPromptPrefix: "You are main." };
const plainText = { widgets: "plain_text" } as const;

function fakeSources() {
  const state = {
    charter: "First charter.",
    memoryIndex: "First memory.",
    materialReads: 0,
    memoryReads: 0,
    changed: () => {},
  };
  const sources: PromptSources = {
    material(): PromptMaterial {
      state.materialReads += 1;
      return {
        charter: state.charter,
        identity: null,
        runtime: {
          profileDir: "/profile",
          profileMemoryDir: "/profile/memory",
          customAppAuthoringDir: "/profile/projects/apps",
          installedAppsDir: "/profile/apps/installed",
          repoAppsDir: "/repo/rome_apps",
          internalApiBaseUrl: "http://127.0.0.1:4141",
          docsDir: null,
        },
        installedApps: [],
      };
    },
    memory(): PromptMemory {
      state.memoryReads += 1;
      return { index: state.memoryIndex, projects: [] };
    },
    onChanged(listener) {
      state.changed = listener;
    },
  };
  return { sources, state };
}

describe("createSystemPrompts", () => {
  it("holds an agent's fixed part until the sources change", () => {
    const { sources, state } = fakeSources();
    const systemPrompts = createSystemPrompts({ sources });

    expect(systemPrompts.build(agent, plainText)).toContain("First charter.");
    state.charter = "Second charter.";
    expect(systemPrompts.build(agent, plainText)).toContain("First charter.");
    expect(state.materialReads).toBe(1);

    state.changed();
    expect(systemPrompts.build(agent, plainText)).toContain("Second charter.");
  });

  it("holds a fixed part per agent and per owner", () => {
    const { sources } = fakeSources();
    const systemPrompts = createSystemPrompts({ sources });

    const core = systemPrompts.build(agent, plainText);
    const other = systemPrompts.build({ ...agent, name: "envoy" }, plainText);
    const app = systemPrompts.build({ ...agent, owner: "app" }, plainText);

    expect(core).toContain("First memory.");
    expect(other).not.toContain("First memory.");
    expect(app).toBe("You are main.");
  });

  it("reads memory on every build", () => {
    const { sources, state } = fakeSources();
    const systemPrompts = createSystemPrompts({ sources });

    expect(systemPrompts.build(agent, plainText)).toContain("First memory.");
    state.memoryIndex = "Second memory.";
    expect(systemPrompts.build(agent, plainText)).toContain("Second memory.");
  });

  it("reads no memory for an agent that does not carry it", () => {
    const { sources, state } = fakeSources();
    createSystemPrompts({ sources }).build({ ...agent, name: "envoy" }, plainText);
    expect(state.memoryReads).toBe(0);
  });
});
