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
  "system:read_ai_tools",
  "system:sign_in_ai_tool",
  "system:sign_out_ai_tool",
  "system:change_ai_tool",
  "system:read_apps",
  "system:search_app_store",
  "system:manage_app",
  "system:publish_app",
  "system:share_app",
  "system:read_connections",
  "system:connect_service",
  "system:disconnect_service",
  "system:read_devices",
  "system:run_on_device",
  "system:rename_device",
  "system:remove_device",
  "system:read_routines",
  "system:change_routine",
  "system:list_routine_runs",
  "system:read_routine_run",
  "system:pause_routine",
  "system:resume_routine",
  "system:run_routine",
  "system:stop_routine_run",
  "system:stop_routine",
  "system:start_chat",
  "system:change_chat",
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

    const aliases = Object.fromEntries(
      agentTools
        .map((tool) => [tool.name, registry.getMetadata(tool.name)?.aliases ?? []] as const)
        .filter(([, names]) => names.length > 0),
    );
    expect(aliases).toEqual(OLDER_NAMES);
  });
});

// The older actions each tool took over, which agents and saved routines still call.
const OLDER_NAMES = {
  "system:search_app_store": ["system:app_store_search"],
  "system:read_devices": ["core:device_describe"],
  "system:run_on_device": ["core:device_run"],
  "system:read_routines": ["system:list_routine_runs", "system:read_routine_run"],
  "system:stop_routine_run": ["system:stop_routine"],
};
