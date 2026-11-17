import { describe, expect, it } from "@rstest/core";
import { showCardTools } from "./show-card-tool.js";

const UI = {
  components: [
    { id: "root", component: "Row", children: ["sleep", "steps"] },
    { id: "sleep", component: "Stat", label: "Sleep", value: "7h 12m" },
    { id: "steps", component: "Stat", label: "Steps", value: 8432 },
  ],
};
const TEXT = "Sleep 7h 12m, 8,432 steps.";

const call = (widgets: "card" | "plain_text", args: Record<string, unknown>, hasSpeaker = true) => {
  const [tool] = showCardTools({ widgets, hasSpeaker });
  return tool!.handler(args, { toolUseId: "tu-1" });
};

describe("show_card for every agent", () => {
  it("hands the drain the card to store where cards show", async () => {
    const result = await call("card", { ui: UI, text: TEXT });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      showWidget: true,
      appId: "core",
      ui: UI,
      text: TEXT,
    });
  });

  it("asks for text where cards cannot show, and in a fork", async () => {
    for (const result of [
      await call("plain_text", { ui: UI, text: TEXT }),
      await call("card", { ui: UI, text: TEXT }, false),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("write the content in your reply");
    }
  });

  it("returns the problems of a card it refuses", async () => {
    const ui = {
      components: [{ id: "root", component: "TextField", label: "Name", value: { path: "/n" } }],
    };
    const result = await call("card", { ui, text: "Name" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("TextField");
    expect(result.content[0]!.text).not.toContain("showWidget");
  });
});
