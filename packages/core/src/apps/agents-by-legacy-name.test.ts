import { describe, expect, it } from "@rstest/core";
import { agentsByLegacyName } from "./agents-by-legacy-name.js";
import { createEmptyLegacyArtifactBindings, formatArtifactId } from "./artifact-id.js";
import { buildAgent } from "../test/helpers.js";

describe("agentsByLegacyName", () => {
  it("lists legacy names only while their canonical agent is loaded", () => {
    const main = buildAgent("core:test-main");
    const bindings = createEmptyLegacyArtifactBindings();
    bindings.agent["test-main"] = formatArtifactId("core", "test-main");
    bindings.agent.orphan = formatArtifactId("missing-app", "reviewer");

    const agents = agentsByLegacyName([main], bindings);

    expect(agents.get("core:test-main")).toBe(main);
    expect(agents.get("test-main")).toBe(main);
    expect(agents.has("orphan")).toBe(false);
  });
});
