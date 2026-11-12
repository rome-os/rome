import { describe, expect, it } from "@rstest/core";
import { checkWidgetUi, type WidgetUi } from "./widget-ui.js";

const mealCard: WidgetUi = {
  components: [
    { id: "root", component: "Column", children: ["title", "calories", "goal", "meals", "water"] },
    { id: "title", component: "Text", text: "Today's meals", variant: "h3" },
    {
      id: "calories",
      component: "Stat",
      label: "Calories",
      value: { path: "/today/calories" },
      unit: "kcal",
    },
    {
      id: "goal",
      component: "Progress",
      value: { path: "/today/calories" },
      max: { path: "/today/goal" },
    },
    { id: "meals", component: "List", children: { componentId: "meal", path: "/today/meals" } },
    { id: "meal", component: "Text", text: { path: "name" } },
    {
      id: "water",
      component: "Button",
      child: "water-label",
      action: { event: { name: "water", context: { date: "2026-11-11" } } },
    },
    { id: "water-label", component: "Text", text: "Log a glass of water" },
  ],
};

describe("checkWidgetUi", () => {
  it("accepts a card every reader can draw", () => {
    expect(checkWidgetUi(mealCard, { "/today": "days/2026-11-11" })).toEqual([]);
  });

  it("rejects a component outside the catalog", () => {
    const ui = { components: [{ id: "root", component: "Modal", child: "x" }] };
    expect(checkWidgetUi(ui)).not.toEqual([]);
  });

  it("rejects a function call, which the iOS app does not evaluate", () => {
    const ui = { components: [{ id: "root", component: "Text", text: { call: "formatDate" } }] };
    expect(checkWidgetUi(ui)).not.toEqual([]);
  });

  it("names a missing root, a missing child and a reused id", () => {
    const ui = {
      components: [
        { id: "top", component: "Column", children: ["gone"] },
        { id: "top", component: "Text", text: "a" },
      ],
    };
    const problems = checkWidgetUi(ui).join("\n");
    expect(problems).toContain('"root"');
    expect(problems).toContain('"gone"');
    expect(problems).toContain("used twice");
  });

  it("rejects a cycle", () => {
    const ui = {
      components: [
        { id: "root", component: "Column", children: ["a"] },
        { id: "a", component: "Row", children: ["root"] },
      ],
    };
    expect(checkWidgetUi(ui)).toContain("the components contain a cycle");
  });

  it("keeps every read and post inside the app's API", () => {
    const post = (name: string) => ({
      components: [
        { id: "root", component: "Button", child: "l", action: { event: { name } } },
        { id: "l", component: "Text", text: "Go" },
      ],
    });
    for (const name of [
      "/api/system",
      "../system/x",
      "https://evil.example",
      "a?b=1",
      "%2e%2e/%2e%2e/settings",
      "..\\..\\settings",
      "a//b",
      "",
    ]) {
      expect(checkWidgetUi(post(name))).not.toEqual([]);
    }
    expect(checkWidgetUi(mealCard, { "/today": "../connector/tokens" })).not.toEqual([]);
    expect(checkWidgetUi(mealCard, { today: "days/1" })).not.toEqual([]);
    expect(checkWidgetUi(mealCard, { "/today": "%2E%2E/connector/tokens" })).not.toEqual([]);
  });
});
