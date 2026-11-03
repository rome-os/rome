import { describe, expect, it } from "@rstest/core";
import type { AgentCatalogGroup } from "./chat-types";
import { filterAgentCatalog } from "./agent-catalog-filter";

const CATALOG: AgentCatalogGroup[] = [
  {
    ownerId: "core",
    ownerType: "core",
    label: "Rome",
    description: "",
    iconUrl: null,
    agents: [{ name: "main", localName: "main", description: "" }],
  },
  {
    ownerId: "research",
    ownerType: "app",
    label: "Research",
    description: "",
    iconUrl: null,
    agents: [
      { name: "research:explorer", localName: "explorer", description: "" },
      { name: "research:writer", localName: "writer", description: "" },
    ],
  },
];

const names = (groups: AgentCatalogGroup[]) =>
  groups.map((group) => [group.ownerId, group.agents.map((agent) => agent.name)]);

describe("filterAgentCatalog", () => {
  it("keeps the whole catalog for an empty query", () => {
    expect(filterAgentCatalog(CATALOG, "")).toEqual(CATALOG);
  });

  it("keeps every agent of an app whose id or label matches", () => {
    expect(names(filterAgentCatalog(CATALOG, "RESEARCH"))).toEqual([
      ["research", ["research:explorer", "research:writer"]],
    ]);
  });

  it("keeps only the matching agents of an app that did not match itself", () => {
    expect(names(filterAgentCatalog(CATALOG, "writ"))).toEqual([["research", ["research:writer"]]]);
    expect(names(filterAgentCatalog(CATALOG, "research/expl"))).toEqual([
      ["research", ["research:explorer"]],
    ]);
  });

  it("drops apps with nothing left", () => {
    expect(filterAgentCatalog(CATALOG, "nothing")).toEqual([]);
  });
});
