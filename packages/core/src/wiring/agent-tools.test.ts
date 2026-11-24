import { describe, expect, it } from "@rstest/core";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import {
  type AgentToolDeps,
  agentToolNames,
  agentToolOlderNames,
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
  "system:read_ai_tools",
  "system:sign_out_ai_tool",
  "system:change_ai_tool",
];

describe("core's agent tools", () => {
  it("lists every tool under the name agents and saved routines call it by", () => {
    expect([...agentToolNames].sort()).toEqual([...NAMES].sort());
  });

  it("runs connect_account, which shipped phones name, as system:connect_service", () => {
    expect(agentToolOlderNames.get("connect_account")).toBe("system:connect_service");
  });

  it("maps each older name to one tool, never to another tool's own name", () => {
    for (const [older, tool] of agentToolOlderNames) {
      expect(agentToolNames.has(tool)).toBe(true);
      expect(agentToolNames.has(older)).toBe(false);
    }
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
});
