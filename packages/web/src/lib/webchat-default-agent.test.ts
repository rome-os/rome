import { describe, expect, it } from "@rstest/core";
import type { AgentCatalogGroup } from "@/lib/chat-types";
import { findMainAgentName, resolveDefaultAgentMention } from "./webchat-default-agent";

const catalog: AgentCatalogGroup[] = [
  {
    ownerId: "notes",
    ownerType: "app",
    label: "Notes",
    description: "Works with notes",
    iconUrl: "/api/apps/notes/icon",
    agents: [{ name: "notes:writer", localName: "Writer", description: "Drafts notes" }],
  },
  {
    ownerId: "core",
    ownerType: "core",
    label: "Rome",
    description: "",
    iconUrl: null,
    agents: [{ name: "core:main", localName: "Rome", description: "Main agent" }],
  },
];

describe("Webchat default agent resolution", () => {
  it("resolves canonical identity while taking display metadata from the live catalog", () => {
    expect(resolveDefaultAgentMention(catalog, "notes:writer")).toEqual({
      appId: "notes",
      appLabel: "Notes",
      agentName: "notes:writer",
      iconUrl: "/api/apps/notes/icon",
    });
  });

  it("treats missing and main agents as an unscoped main-agent draft", () => {
    expect(resolveDefaultAgentMention(catalog, "removed:agent")).toBeNull();
    expect(resolveDefaultAgentMention(catalog, "core:main")).toBeNull();
    expect(findMainAgentName(catalog)).toBe("core:main");
  });
});
