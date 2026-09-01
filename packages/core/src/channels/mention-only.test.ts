import { describe, expect, it } from "vitest";
import { preserveMentionOnlyText } from "./mention-only.js";

describe("preserveMentionOnlyText", () => {
  it("restores the visible bot mention when stripping leaves no text", () => {
    expect(preserveMentionOnlyText("", true, "Project Bot")).toBe("@Project Bot");
  });

  it("uses Rome when the provider has no bot display name", () => {
    expect(preserveMentionOnlyText("", true)).toBe("@Rome");
  });

  it("keeps addressed prose and unrelated empty messages unchanged", () => {
    expect(preserveMentionOnlyText("please review", true, "Rome")).toBe("please review");
    expect(preserveMentionOnlyText("", false, "Rome")).toBe("");
  });
});
