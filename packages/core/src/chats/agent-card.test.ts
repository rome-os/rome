import { describe, expect, it } from "@rstest/core";
import { AGENT_CARD_MAX_UI_CHARS, agentCardPart, checkAgentCard } from "./agent-card.js";

const NUMBERS = {
  components: [
    { id: "root", component: "Row", children: ["rent", "food"] },
    { id: "rent", component: "Stat", label: "Rent", value: 2400, unit: "USD" },
    { id: "food", component: "Stat", label: "Food", value: "620", unit: "USD" },
  ],
};

describe("agent card", () => {
  it("takes display components with every value written out", () => {
    expect(checkAgentCard(NUMBERS, "Rent 2400 USD, food 620 USD")).toEqual([]);
    expect(agentCardPart(NUMBERS, "  Rent and food  ", "call-1")).toEqual({
      part: {
        type: "widget",
        toolUseId: "call-1",
        appId: "core",
        text: "Rent and food",
        ui: NUMBERS,
      },
    });
  });

  it.each([
    "Button",
    "ChoicePicker",
    "TextField",
  ])("refuses a %s, which nobody would handle", (kind) => {
    const component =
      kind === "Button"
        ? { id: "x", component: kind, child: "t", action: { event: { name: "go" } } }
        : kind === "ChoicePicker"
          ? {
              id: "x",
              component: kind,
              options: [{ label: "A", value: "a" }],
              value: { path: "/p" },
            }
          : { id: "x", component: kind, label: "Name", value: { path: "/p" } };
    const ui = {
      components: [
        { id: "root", component: "Column", children: ["x", "t"] },
        component,
        { id: "t", component: "Text", text: "Go" },
      ],
    };
    expect(checkAgentCard(ui, "Go").join("\n")).toContain(`is a ${kind}`);
  });

  it("refuses a data model and any value read from one", () => {
    const ui = {
      components: [{ id: "root", component: "Text", text: { path: "/title" } }],
      data: { title: "Hi" },
    };
    const problems = checkAgentCard(ui, "Hi");
    expect(problems.join("\n")).toContain("ui.data");
    expect(problems.join("\n")).toContain("ui.components.0.text");
  });

  it("refuses a list drawn from data", () => {
    const ui = {
      components: [
        { id: "root", component: "List", children: { componentId: "row", path: "/rows" } },
        { id: "row", component: "Text", text: "x" },
      ],
    };
    expect(checkAgentCard(ui, "x").join("\n")).toContain("ui.components.0.children");
  });

  it("refuses an image that is not https", () => {
    const ui = {
      components: [{ id: "root", component: "Image", url: "http://example.com/a.png" }],
    };
    expect(checkAgentCard(ui, "A picture").join("\n")).toContain("https");
  });

  it("refuses a card without its plain text, or over the size cap", () => {
    expect(checkAgentCard(NUMBERS, "  ").join("\n")).toContain("text is required");
    const long = {
      components: [{ id: "root", component: "Text", text: "x".repeat(AGENT_CARD_MAX_UI_CHARS) }],
    };
    expect(checkAgentCard(long, "x").join("\n")).toContain("over the");
  });

  it("passes on the shape problems every reader checks", () => {
    const ui = { components: [{ id: "top", component: "Text", text: "Hi" }] };
    expect(checkAgentCard(ui, "Hi")).toEqual(['no component has the id "root"']);
  });
});
