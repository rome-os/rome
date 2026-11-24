import { describe, expect, it } from "@rstest/core";
import { MODEL_SELECTIONS } from "../packages/core/src/agent/domain/model-selection.js";
import { LARGE_MODEL_OPTIONS } from "../packages/web/src/lib/model-options.js";

describe("model selection fallback", () => {
  it("keeps every stored selection on the agent domain's exact wire identity", () => {
    const options = LARGE_MODEL_OPTIONS.filter((option) => option.id !== "auto");
    expect(options.map((option) => option.id).sort()).toEqual(Object.keys(MODEL_SELECTIONS).sort());
    for (const option of options) {
      expect(option).toMatchObject(MODEL_SELECTIONS[option.id]);
    }
  });

  it("offers distinct complete wire identities without folding versions or context variants", () => {
    const identities = LARGE_MODEL_OPTIONS.map(({ providerId, model }) =>
      JSON.stringify([providerId, model]),
    );
    expect(new Set(identities).size).toBe(identities.length);
  });
});
