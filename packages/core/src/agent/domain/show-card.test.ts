import { describe, expect, it } from "@rstest/core";
import {
  checkShowCard,
  parseShowCardInput,
  SHOW_CARD_MAX_COMPONENTS,
  showCardToolOutput,
} from "./show-card.js";

const tiles = {
  components: [
    { id: "root", component: "Column", children: ["title", "row"] },
    { id: "title", component: "Text", variant: "h3", text: "Daily health summary" },
    { id: "row", component: "Row", children: ["sleep", "hr"] },
    { id: "sleep", component: "Stat", label: "Sleep", value: "7h 25m" },
    { id: "hr", component: "Stat", label: "Resting HR", value: 53, unit: "bpm" },
  ],
};

describe("checkShowCard", () => {
  it("accepts a card of text, tiles and layout", () => {
    expect(checkShowCard(tiles)).toEqual([]);
  });

  it.each(["Button", "Image", "TextField", "ChoicePicker"])("refuses a %s", (component) => {
    const ui = {
      components: [
        { id: "root", component: "Column", children: ["x", "label"] },
        { id: "label", component: "Text", text: "Go" },
        component === "Button"
          ? { id: "x", component, child: "label", action: { event: { name: "a" } } }
          : component === "Image"
            ? { id: "x", component, url: "https://example.com/a.png" }
            : component === "TextField"
              ? { id: "x", component, label: "L", value: { path: "/v" } }
              : {
                  id: "x",
                  component,
                  options: [{ label: "A", value: "a" }],
                  value: { path: "/v" },
                },
      ],
    };
    expect(checkShowCard(ui).join()).toContain("may not use");
  });

  it("refuses a component nothing draws", () => {
    const ui = { components: [...tiles.components, { id: "lost", component: "Text", text: "x" }] };
    expect(checkShowCard(ui)).toEqual([
      '"lost" is not a child of any component, so it would not show',
    ]);
  });

  it("refuses a card that is too big", () => {
    const items = Array.from({ length: SHOW_CARD_MAX_COMPONENTS }, (_, i) => `t${i}`);
    const ui = {
      components: [
        { id: "root", component: "List", children: items },
        ...items.map((id) => ({ id, component: "Text", text: id })),
      ],
    };
    expect(checkShowCard(ui).join()).toContain("more than");
  });

  it("refuses what is not a card", () => {
    expect(checkShowCard({ components: [] }).length).toBeGreaterThan(0);
    expect(checkShowCard(null).length).toBeGreaterThan(0);
  });
});

describe("parseShowCardInput", () => {
  it("needs the card's text version", () => {
    expect(parseShowCardInput({ ui: tiles })).toMatchObject({ ok: false });
    expect(parseShowCardInput({ ui: tiles, text: " Sleep 7h 25m. " })).toEqual({
      ok: true,
      ui: tiles,
      text: "Sleep 7h 25m.",
    });
  });
});

describe("showCardToolOutput", () => {
  it("shows the card where widgets show", () => {
    expect(showCardToolOutput(tiles as never, "Sleep 7h 25m.", true)).toMatchObject({
      showWidget: true,
      appId: "core",
      ui: tiles,
      text: "Sleep 7h 25m.",
    });
  });

  it("asks for the text elsewhere", () => {
    const out = showCardToolOutput(tiles as never, "Sleep 7h 25m.", false) as { message: string };
    expect(out).not.toHaveProperty("showWidget");
    expect(out.message).toContain("Sleep 7h 25m.");
  });
});
