import { describe, expect, it } from "@rstest/core";
import { ActionRegistryImpl } from "../apps/actions/registry.js";
import { type AgentToolDeps, agentToolNames, registerAgentTools } from "./agent-tools.js";

// Agents, agent prompts and saved routines call these names.
const NAMES = [
  "system:read_connections",
  "system:disconnect_service",
  "system:read_routines",
  "system:change_routine",
  "system:list_routine_runs",
  "system:read_routine_run",
  "system:pause_routine",
  "system:resume_routine",
  "system:run_routine",
  "system:stop_routine_run",
  "system:stop_routine",
  "system:read_devices",
  "system:run_on_device",
  "system:rename_device",
  "system:remove_device",
];

// The verbs a tool's name opens with. A new verb joins the list with the first
// tool that uses it. The naming rules: docs/concepts/actions.md#core-agent-tools.
const VERBS = [
  "read",
  "change",
  "pause",
  "resume",
  "run",
  "stop",
  "rename",
  "remove",
  "disconnect",
];

// Older names this check refuses, which stay since a tool is never renamed.
// A new tool's name never joins the list.
const OLDER_NAMES = ["system:list_routine_runs"];

function namingProblem(name: string): string | null {
  const words = /^system:([a-z]+)(?:_[a-z]+)+$/.exec(name);
  if (!words) return `${name} is not system:<verb>_<thing> in lower-case words joined by "_"`;
  if (!VERBS.includes(words[1])) return `${name} opens with "${words[1]}", which is not in VERBS`;
  return null;
}

describe("core's agent tools", () => {
  it("lists every tool under the name agents and saved routines call it by", () => {
    expect([...agentToolNames].sort()).toEqual([...NAMES].sort());
  });

  it("names every tool as docs/concepts/actions.md#core-agent-tools says", () => {
    const checked = [...agentToolNames].filter((name) => !OLDER_NAMES.includes(name));

    expect(checked.map(namingProblem).filter(Boolean)).toEqual([]);
  });

  it("excuses only names that are still tools and still break the naming rules", () => {
    for (const name of OLDER_NAMES) {
      expect(agentToolNames.has(name)).toBe(true);
      expect(namingProblem(name)).not.toBeNull();
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
