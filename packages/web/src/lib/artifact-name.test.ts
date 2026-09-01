import { describe, expect, it } from "@rstest/core";
import { artifactLocalName, artifactOwnerId } from "./artifact-name";

describe("artifact presentation names", () => {
  it("separates a canonical artifact id into owner and local name", () => {
    expect(artifactOwnerId("dream:skill_review")).toBe("dream");
    expect(artifactLocalName("dream:skill_review")).toBe("skill_review");
  });

  it("keeps legacy bare names readable", () => {
    expect(artifactOwnerId("skill_review")).toBeNull();
    expect(artifactLocalName("skill_review")).toBe("skill_review");
  });
});
