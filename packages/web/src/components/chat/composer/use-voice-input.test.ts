import { describe, expect, it } from "@rstest/core";
import { spokenInsertion } from "./use-voice-input";

describe("spokenInsertion", () => {
  it("separates spoken words from a word typed right before the cursor", () => {
    expect(spokenInsertion("Note:", "buy milk")).toBe(" buy milk");
    expect(spokenInsertion("Note: ", " buy milk")).toBe("buy milk");
    expect(spokenInsertion("", " buy milk")).toBe("buy milk");
  });

  it("adds no space around Chinese", () => {
    expect(spokenInsertion("备注", "买牛奶")).toBe("买牛奶");
    expect(spokenInsertion("Note", "买牛奶")).toBe("买牛奶");
    expect(spokenInsertion("买", "milk")).toBe("milk");
  });
});
