import { describe, expect, it } from "@rstest/core";
import { chatFloorLayering } from "./chat-floor";

describe("chatFloorLayering", () => {
  it("lets a press beside the composer reach an open thread view, at every width", () => {
    // A floor taking presses below md covered the view's blurred edge on a phone.
    expect(chatFloorLayering(true)).not.toMatch(/pointer-events-auto/);
    expect(chatFloorLayering(true)).not.toMatch(/bg-/);
  });

  it("paints the canvas and takes presses below md with no thread view open", () => {
    expect(chatFloorLayering(false)).toContain("max-md:pointer-events-auto");
    expect(chatFloorLayering(false)).toContain("max-md:bg-chat-canvas");
  });
});
