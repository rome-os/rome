import { afterEach, describe, expect, it, rs } from "@rstest/core";
import type { GatedFeature } from "@rome/api-types/features";
import { hiddenFeatures, isShownInTest } from "@/test/features";
import type { AgentCatalogGroup } from "./chat-types";
import { filterAgentCatalog } from "./agent-catalog-filter";

rs.mock("@/lib/features", () => ({
  isShown: (feature?: GatedFeature) => isShownInTest(feature),
}));

afterEach(() => {
  hiddenFeatures.clear();
});

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

describe("filterAgentCatalog for a hidden feature", () => {
  const inbox: AgentCatalogGroup = {
    ownerId: "inbox",
    ownerType: "app",
    label: "Inbox",
    description: "",
    iconUrl: null,
    agents: [{ name: "inbox:sentinel", localName: "sentinel", description: "" }],
  };

  it("offers no agents of an app that is a hidden feature, even when asked by name", () => {
    hiddenFeatures.add("inbox");
    expect(names(filterAgentCatalog([...CATALOG, inbox], ""))).toEqual(names(CATALOG));
    expect(filterAgentCatalog([...CATALOG, inbox], "inbox")).toEqual([]);
  });

  it("offers them while the feature is shown", () => {
    expect(names(filterAgentCatalog([inbox], "inbox"))).toEqual([["inbox", ["inbox:sentinel"]]]);
  });
});
