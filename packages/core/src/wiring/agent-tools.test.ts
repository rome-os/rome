import { describe, expect, it } from "@rstest/core";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import {
  type AgentToolDeps,
  agentToolNames,
  agentTools,
  registerAgentTools,
} from "./agent-tools.js";

// Agents, agent prompts and saved routines call these names.
const NAMES = [
  "system:read_connections",
  "system:connect_service",
  "system:disconnect_service",
  "system:list_routine_runs",
  "system:read_routine_run",
  "system:pause_routine",
  "system:resume_routine",
  "system:run_routine",
  "system:stop_routine",
];

describe("core's agent tools", () => {
  it("lists every tool under the name agents and saved routines call it by", () => {
    expect([...agentToolNames].sort()).toEqual([...NAMES].sort());
  });

  it("registers every tool it lists as an action an agent can call, owned by core", () => {
    const registry = new ActionRegistryImpl();

    registerAgentTools(registry, async () => "guardian", {} as AgentToolDeps);

    expect(registry.list().sort()).toEqual([...NAMES].sort());
    for (const name of NAMES) {
      expect(registry.get(name)?.inputSchema).toBeDefined();
      expect(registry.getMetadata(name)?.ownerType).toBe("core");
    }
  });

  it("names each tool's older names as its aliases, which the agent's catalog leaves unlisted", () => {
    const registry = new ActionRegistryImpl();

    registerAgentTools(registry, async () => "guardian", {} as AgentToolDeps);

    for (const tool of agentTools) {
      expect(registry.getMetadata(tool.name)?.aliases).toEqual([...tool.olderNames]);
    }
  });
});
