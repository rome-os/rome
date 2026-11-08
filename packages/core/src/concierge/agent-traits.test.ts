import { describe, expect, it } from "@rstest/core";
import { join } from "node:path";
import { AgentLoader } from "../agent/index.js";
import { createEmptyLegacyArtifactBindings } from "../apps/artifact-id.js";
import { ROME_AGENT_TRAITS } from "./agent-traits.js";

describe("ROME_AGENT_TRAITS", () => {
  it("gives the shipped Concierge a saved model that outranks its session's pinned one", async () => {
    const loader = new AgentLoader(
      { legacyBindings: createEmptyLegacyArtifactBindings() },
      ROME_AGENT_TRAITS,
    );
    await loader.loadAll(join(import.meta.dirname, "..", "..", "agents"));
    expect(loader.find("core:concierge")?.definition.savedSelectionOutranksPin).toBe(true);
    expect(loader.find("core:main")?.definition.savedSelectionOutranksPin).toBeUndefined();
  });
});
