import { describe, expect, it } from "@rstest/core";
import { formatResultForAgent } from "./approval-handler.js";

describe("formatResultForAgent", () => {
  it("does not say an approved action's card was shown, because none is stored", () => {
    const text = formatResultForAgent({
      status: "show_widget",
      widget: { componentId: "today", text: "You ate twice today." },
    });

    expect(text).toContain('"today" card is not shown');
    expect(text).toContain("You ate twice today.");
  });
});
