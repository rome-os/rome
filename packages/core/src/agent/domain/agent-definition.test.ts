import { describe, expect, it } from "@rstest/core";
import {
  type Agent,
  type AgentCatalog,
  type AgentDefinition,
  requireAgent,
  resolveSubagents,
} from "./agent-definition.js";

const definition = (allowedSubagents?: string[]): AgentDefinition => ({
  description: "An agent",
  tier: "small",
  reasoningEffort: "high",
  systemPromptPrefix: "You are an agent.",
  tools: [],
  permissionMode: "default",
  ...(allowedSubagents ? { allowedSubagents } : {}),
});

const agent = (name: string): Agent => ({
  name,
  localName: name.split(":")[1] ?? name,
  ownerType: "app",
  ownerId: name.split(":")[0] ?? name,
  definition: definition(),
});

const catalogOf = (...agents: Agent[]): AgentCatalog => ({
  list: () => agents,
  find: (name) => agents.find((a) => a.name === name || a.localName === name),
});

describe("requireAgent", () => {
  it("returns the agent by any name the catalog knows", () => {
    const helper = agent("crm:helper");
    expect(requireAgent(catalogOf(helper), "helper")).toBe(helper);
  });

  it("names the installed agents in load order when the name is unknown", () => {
    const catalog = catalogOf(agent("crm:b"), agent("crm:a"));
    expect(() => requireAgent(catalog, "nope")).toThrow(
      'Agent "nope" not found. Available agents: crm:b, crm:a',
    );
  });

  it("says none are loaded when the catalog is empty", () => {
    expect(() => requireAgent(catalogOf(), "nope")).toThrow(
      'Agent "nope" not found. Available agents: (none loaded)',
    );
  });
});

describe("resolveSubagents", () => {
  const installed = new Map([
    ["helper", "crm:helper"],
    ["crm:helper", "crm:helper"],
    ["notes:writer", "notes:writer"],
  ]);
  const installedId = (reference: string) => installed.get(reference);

  const cases: {
    name: string;
    subagents?: string[];
    ownerType: Agent["ownerType"];
    expected: ReturnType<typeof resolveSubagents>;
  }[] = [
    {
      name: "an agent with no subagents resolves to none",
      ownerType: "app",
      expected: { ok: true, subagents: [], dropped: [] },
    },
    {
      name: "references resolve to canonical ids, in order",
      subagents: ["notes:writer", "helper"],
      ownerType: "app",
      expected: { ok: true, subagents: ["notes:writer", "crm:helper"], dropped: [] },
    },
    {
      name: "a core agent loads without a subagent that is not installed",
      subagents: ["helper", "gone:agent", "notes:writer"],
      ownerType: "core",
      expected: { ok: true, subagents: ["crm:helper", "notes:writer"], dropped: ["gone:agent"] },
    },
    {
      name: "an app's agent fails on the first subagent that is not installed",
      subagents: ["helper", "gone:agent", "also:gone"],
      ownerType: "app",
      expected: { ok: false, missing: "gone:agent" },
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveSubagents(definition(c.subagents), c.ownerType, installedId)).toEqual(
        c.expected,
      );
    });
  }
});
