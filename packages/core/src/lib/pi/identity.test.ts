import { describe, expect, it } from "@rstest/core";
import {
  InvalidPiModelIdentityError,
  parseQualifiedPiModelId,
  qualifyPiModelId,
} from "./identity.js";

describe("Pi qualified model identities", () => {
  it("round-trips provider and model ids containing separators and percent signs", () => {
    const qualified = qualifyPiModelId("provider/region%one", "model/family%latest");

    expect(qualified).toBe("provider%2Fregion%25one/model%2Ffamily%25latest");
    expect(parseQualifiedPiModelId(qualified)).toEqual({
      upstreamProvider: "provider/region%one",
      modelId: "model/family%latest",
    });
  });

  it("does not collide when a separator moves between the two components", () => {
    expect(qualifyPiModelId("alpha/beta", "gamma")).not.toBe(
      qualifyPiModelId("alpha", "beta/gamma"),
    );
  });

  it.each([
    "",
    "provider",
    "/model",
    "provider/",
    "provider/model/extra",
    "provider%2fregion/model",
    "provider/%",
    "provider/%2f",
  ])("rejects a malformed or non-canonical identity: %s", (value) => {
    expect(() => parseQualifiedPiModelId(value)).toThrow(InvalidPiModelIdentityError);
  });

  it("rejects empty identity components", () => {
    expect(() => qualifyPiModelId("", "model")).toThrow(InvalidPiModelIdentityError);
    expect(() => qualifyPiModelId("provider", "")).toThrow(InvalidPiModelIdentityError);
  });
});
