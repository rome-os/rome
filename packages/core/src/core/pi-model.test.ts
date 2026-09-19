import { describe, expect, it } from "@rstest/core";
import { parseQualifiedPiModelId, qualifyPiModelId } from "./pi-model.js";

describe("Pi qualified model IDs", () => {
  it("round-trips provider and model components without collisions", () => {
    const id = qualifyPiModelId("custom/proxy", "vendor/model v2");
    expect(id).toBe("custom%2Fproxy/vendor%2Fmodel%20v2");
    expect(parseQualifiedPiModelId(id)).toEqual({
      upstreamProvider: "custom/proxy",
      modelId: "vendor/model v2",
    });
  });

  it("rejects bare and malformed IDs", () => {
    expect(parseQualifiedPiModelId("bare-model")).toBeNull();
    expect(parseQualifiedPiModelId("bad%/model")).toBeNull();
  });
});
