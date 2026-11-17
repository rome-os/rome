import { describe, expect, it } from "@rstest/core";
import { checkWidgetUi, type WidgetUi, widgetStatTone } from "./widget-ui.js";

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

  it("accepts Markdown text", () => {
    const ui = {
      components: [{ id: "root", component: "Markdown", text: "**Sleep** was *good*." }],
    };
    expect(checkWidgetUi(ui)).toEqual([]);
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
      "a#b",
    ]) {
      expect(checkWidgetUi(post(name))).not.toEqual([]);
    }
    expect(checkWidgetUi(mealCard, { "/today": "../connector/tokens" })).not.toEqual([]);
    expect(checkWidgetUi(mealCard, { today: "days/1" })).not.toEqual([]);
    expect(checkWidgetUi(mealCard, { "/today": "%2E%2E/connector/tokens" })).not.toEqual([]);
  });

  it("draws only https images, which every reader loads the same way", () => {
    const card = (url: unknown) => ({ components: [{ id: "root", component: "Image", url }] });
    expect(checkWidgetUi(card("https://example.com/a.png"))).toEqual([]);
    expect(checkWidgetUi(card({ path: "/today/photo" }))).toEqual([]);
    for (const url of ["/api/settings", "http://example.com/a.png", "photo.png", "data:x"]) {
      expect(checkWidgetUi(card(url))).not.toEqual([]);
    }
  });

  it("takes a stat's range, a callout, a bar chart, icons and links", () => {
    const ui = {
      components: [
        { id: "root", component: "Column", children: ["sleep", "week", "tip", "stop", "place"] },
        {
          id: "sleep",
          component: "Stat",
          label: "Sleep",
          value: 6.1,
          unit: "h",
          range: { low: 7, high: 7.7 },
          icon: "moon",
        },
        {
          id: "week",
          component: "Chart",
          kind: "bar",
          points: [
            { label: "Mon", value: 7.2 },
            { label: "Today", value: 6.1, highlight: "accent" },
          ],
          unit: "h",
        },
        { id: "tip", component: "Text", text: "An early night helps.", tone: "info" },
        {
          id: "stop",
          component: "Text",
          text: "Belém Tower",
          icon: "map-pin",
          href: "maps://?q=Belem+Tower",
        },
        { id: "place", component: "Row", children: ["tip2"], href: "https://example.com/a" },
        { id: "tip2", component: "Text", text: "Opening hours" },
      ],
    };
    expect(checkWidgetUi(ui)).toEqual([]);
  });

  it("refuses an unknown icon, a link of another scheme, a reversed range and a long chart", () => {
    const one = (c: Record<string, unknown>) => ({ components: [{ id: "root", ...c }] });
    expect(checkWidgetUi(one({ component: "Text", text: "a", icon: "rocket" }))).not.toEqual([]);
    for (const href of ["http://example.com", "javascript:alert(1)", "/api/apps", "tel:123"]) {
      expect(checkWidgetUi(one({ component: "Text", text: "a", href }))).not.toEqual([]);
    }
    expect(
      checkWidgetUi(one({ component: "Stat", label: "a", value: 1, range: { low: 5, high: 2 } })),
    ).not.toEqual([]);
    const points = Array.from({ length: 15 }, (_, i) => ({ label: `${i}`, value: i }));
    expect(checkWidgetUi(one({ component: "Chart", kind: "bar", points }))).not.toEqual([]);
    expect(
      checkWidgetUi(one({ component: "Chart", kind: "line", points: points.slice(0, 3) })),
    ).not.toEqual([]);
    // A link and an icon are a Row's, not a Column's.
    expect(
      checkWidgetUi({
        components: [
          { id: "root", component: "Column", children: ["a"], href: "https://example.com" },
          { id: "a", component: "Text", text: "a" },
        ],
      }),
    ).not.toEqual([]);
  });

  it("never lets one press both open a link and send an event", () => {
    const button = {
      id: "go",
      component: "Button",
      child: "go-label",
      action: { event: { name: "go" } },
    };
    // A linked Row that holds a control.
    expect(
      checkWidgetUi({
        components: [
          { id: "root", component: "Row", children: ["go"], href: "https://example.com" },
          button,
          { id: "go-label", component: "Text", text: "Go" },
        ],
      }).join("\n"),
    ).toContain("holds a control");
    // A Button whose label holds a link, directly or deeper.
    for (const label of [
      [{ id: "go-label", component: "Text", text: "Go", href: "https://example.com" }],
      [
        { id: "go-label", component: "Row", children: ["t"], href: "maps://?q=x" },
        { id: "t", component: "Text", text: "Go" },
      ],
    ]) {
      expect(
        checkWidgetUi({ components: [{ ...button, id: "root" }, ...label] }).join("\n"),
      ).toContain("label holds an href");
    }
  });

  it("judges a range only against a number, or a path to one, and takes signed chart values", () => {
    const stat = (value: unknown) => ({
      components: [
        { id: "root", component: "Stat", label: "HR", value, range: { low: 56, high: 60 } },
      ],
    });
    expect(checkWidgetUi(stat("64")).join("\n")).toContain("plain number");
    expect(checkWidgetUi(stat(64))).toEqual([]);
    expect(checkWidgetUi(stat({ path: "/today/hr" }))).toEqual([]);
    const points = [
      { label: "Mon", value: -10 },
      { label: "Tue", value: -100 },
      { label: "Wed", value: 50 },
    ];
    expect(
      checkWidgetUi({ components: [{ id: "root", component: "Chart", kind: "bar", points }] }),
    ).toEqual([]);
  });

  it("says where a value sits against its usual range", () => {
    const range = { low: 56, high: 60 };
    expect(widgetStatTone(64, range)).toBe("high");
    expect(widgetStatTone(52, range)).toBe("low");
    expect(widgetStatTone(56, range)).toBe("normal");
    expect(widgetStatTone("58", range)).toBeNull();
    expect(widgetStatTone("6h 05m", range)).toBeNull();
  });

  it("refuses fields no reader draws", () => {
    const ui = { components: [{ id: "root", component: "Text", text: "a", weight: 1 }] };
    expect(checkWidgetUi(ui)).not.toEqual([]);
  });

  it("takes only the button context values every reader can send", () => {
    const button = (context: unknown) => ({
      components: [
        {
          id: "root",
          component: "Button",
          child: "l",
          action: { event: { name: "water", context } },
        },
        { id: "l", component: "Text", text: "Go" },
      ],
    });
    expect(
      checkWidgetUi(
        button({ date: "2026-11-11", cups: 1, cold: true, tags: ["a"], kcal: { path: "/k" } }),
      ),
    ).toEqual([]);
    expect(checkWidgetUi(button({ meal: { id: 42 } }))).not.toEqual([]);
    expect(checkWidgetUi(button({ meal: null }))).not.toEqual([]);
  });
});
