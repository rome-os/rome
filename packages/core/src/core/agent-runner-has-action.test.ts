import { describe, expect, it } from "@rstest/core";
import { AgentRunner } from "./agent-runner.js";
import type { AgentLoader } from "./agent-loader.js";
import type { AgentSessionManager } from "./agent-session.js";
import { ActionRegistryImpl } from "../actions/registry.js";
import type { Action } from "../actions/types.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";

function action(name: string, visibility: "public" | "explicit"): Action {
  return {
    config: {
      name,
      type: "system",
      description: name,
      visibility,
      complexity: "simple",
      speed: "fast",
      reliability: "high",
      sideEffects: "write",
    },
    inputSchema: { type: "object" },
    execute: async () => ({ status: "ok" }),
  };
}

describe("AgentRunner.hasAction", () => {
  const registry = new ActionRegistryImpl({
    legacyBindings: createEmptyLegacyArtifactBindings(),
  });
  for (const [name, visibility] of [
    ["execute_root_script", "explicit"],
    ["send_message", "public"],
  ] as const) {
    registry.register(action(name, visibility), {
      kind: "action",
      ownerType: "app",
      ownerId: "system",
      publicName: name,
      aliases: [],
      sourcePath: `/system/${name}`,
      formatVersion: 2,
    });
  }
  const agents: Record<string, string[]> = {
    main: ["*", "system:execute_root_script"],
    explore: ["*"],
  };
  const loader = {
    getRecord: (name: string) => {
      if (!agents[name]) throw new Error(`unknown agent ${name}`);
      return { config: { actions: agents[name] } };
    },
  } as unknown as AgentLoader;
  const runner = new AgentRunner({} as AgentSessionManager, loader, undefined, undefined, registry);

  it("resolves through the agent's allow-list, honoring explicit visibility", () => {
    expect(runner.hasAction("main", "system:execute_root_script")).toBe(true);
    expect(runner.hasAction("explore", "system:execute_root_script")).toBe(false);
    expect(runner.hasAction("explore", "system:send_message")).toBe(true);
  });

  it("returns false for unknown agents and actions", () => {
    expect(runner.hasAction("ghost", "system:send_message")).toBe(false);
    expect(runner.hasAction("main", "system:nope")).toBe(false);
  });
});
