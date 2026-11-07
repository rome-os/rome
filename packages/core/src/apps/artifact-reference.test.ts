import { describe, expect, it, rs } from "@rstest/core";
import { createArtifactReferenceResolver } from "./artifact-reference.js";

describe("createArtifactReferenceResolver", () => {
  it("resolves an agent reference through the agent registry", () => {
    const canonicalAgentName = rs.fn(() => "workflow-studio:designer");
    const resolve = createArtifactReferenceResolver({
      canonicalAgentName,
      actionRegistry: { getCanonicalName: rs.fn() },
    });

    expect(
      resolve({
        kind: "agent",
        value: "workflow-studio:designer",
      }),
    ).toBe("workflow-studio:designer");
    expect(canonicalAgentName).toHaveBeenCalledWith("workflow-studio:designer");
  });

  it("resolves an action reference through the action registry", () => {
    const getCanonicalName = rs.fn(() => "workflow-studio:validate-design");
    const resolve = createArtifactReferenceResolver({
      canonicalAgentName: rs.fn(),
      actionRegistry: { getCanonicalName },
    });

    expect(
      resolve({
        kind: "action",
        value: "workflow-studio:validate-design",
      }),
    ).toBe("workflow-studio:validate-design");
    expect(getCanonicalName).toHaveBeenCalledWith("workflow-studio:validate-design");
  });

  it("rejects an action reference missing from the registry", () => {
    const resolve = createArtifactReferenceResolver({
      canonicalAgentName: rs.fn(),
      actionRegistry: { getCanonicalName: rs.fn(() => undefined) },
    });

    expect(() => resolve({ kind: "action", value: "missing" })).toThrow(
      'Action "missing" not found',
    );
  });
});
