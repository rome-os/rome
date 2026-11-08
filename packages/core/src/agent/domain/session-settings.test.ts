import { describe, expect, it } from "@rstest/core";
import { restoresSavedSelection } from "./session-settings.js";

describe("restoresSavedSelection", () => {
  it("restores the saved model for a session pinned to none", () => {
    expect(restoresSavedSelection({}, { pinned: false, selected: false })).toBe(true);
  });

  it("keeps a session's pinned model unless its agent lets the saved model outrank it", () => {
    expect(restoresSavedSelection({}, { pinned: true, selected: false })).toBe(false);
    expect(
      restoresSavedSelection(
        { savedSelectionOutranksPin: true },
        { pinned: true, selected: false },
      ),
    ).toBe(true);
  });

  it("never overrides a model this open selects", () => {
    expect(
      restoresSavedSelection(
        { savedSelectionOutranksPin: true },
        { pinned: false, selected: true },
      ),
    ).toBe(false);
  });
});
