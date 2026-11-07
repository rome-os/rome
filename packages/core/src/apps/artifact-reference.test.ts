import { describe, expect, it, rs } from "@rstest/core";
import { createArtifactReferenceResolver } from "./artifact-reference.js";
import { buildAgent } from "../test/helpers.js";

describe("createArtifactReferenceResolver", () => {
  it("resolves an agent reference through the agent registry", () => {
    const find = rs.fn(() => buildAgent("workflow-studio:designer"));
    const resolve = createArtifactReferenceResolver({
      agentLoader: { find, list: () => [] },
      actionRegistry: { getCanonicalName: rs.fn() },
    });

    expect(
      resolve({
        kind: "agent",
        value: "workflow-studio:designer",
      }),
    ).toBe("workflow-studio:designer");
    expect(find).toHaveBeenCalledWith("workflow-studio:designer");
  });

  it("resolves an action reference through the action registry", () => {
    const getCanonicalName = rs.fn(() => "workflow-studio:validate-design");
    const resolve = createArtifactReferenceResolver({
      agentLoader: { find: rs.fn(), list: () => [] },
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
      agentLoader: { find: rs.fn(), list: () => [] },
      actionRegistry: { getCanonicalName: rs.fn(() => undefined) },
    });

    expect(() => resolve({ kind: "action", value: "missing" })).toThrow(
      'Action "missing" not found',
    );
  });
});
