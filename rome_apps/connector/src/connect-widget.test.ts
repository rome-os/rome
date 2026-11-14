import { checkWidgetUi } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import { connectWidget } from "./connect-widget.js";

describe("the connect card", () => {
  it("is a card every reader can draw, which the agent waits on", () => {
    const widget = connectWidget("notion");
    expect(checkWidgetUi(widget.ui, widget.bind ?? {})).toEqual([]);
    expect(widget.waits).toBe(true);
  });
});
