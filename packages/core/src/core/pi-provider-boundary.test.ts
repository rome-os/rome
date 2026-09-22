import { describe, expect, it } from "@rstest/core";
import {
  decodePiModelId,
  encodePiModelId,
  isReviewedPiProviderId,
  PI_REVIEWED_ONE_TOKEN_PROVIDERS,
} from "./pi-provider-boundary.js";

describe("Pi provider boundary", () => {
  it("round-trips collision-safe qualified model IDs and rejects noncanonical input", () => {
    const left = encodePiModelId({
      upstreamProvider: "custom/provider",
      upstreamModel: "org/model/v2",
    });
    const right = encodePiModelId({
      upstreamProvider: "custom",
      upstreamModel: "provider/org/model/v2",
    });

    expect(left).toBe("custom%2Fprovider/org%2Fmodel%2Fv2");
    expect(right).toBe("custom/provider%2Forg%2Fmodel%2Fv2");
    expect(left).not.toBe(right);
    expect(decodePiModelId(left)).toEqual({
      upstreamProvider: "custom/provider",
      upstreamModel: "org/model/v2",
    });

    for (const invalid of [
      "bare-model",
      "/model",
      "provider/",
      "one/two/three",
      "provider/bad%2fcanonical",
      "provider/bad%",
      "provider/model%00",
    ]) {
      expect(() => decodePiModelId(invalid)).toThrow("Choose a valid qualified Pi model.");
      try {
        decodePiModelId(invalid);
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain(invalid);
      }
    }
  });

  it("keeps the one-token provider catalog closed and includes the distinct Kimi entries", () => {
    expect(isReviewedPiProviderId("anthropic")).toBe(true);
    expect(isReviewedPiProviderId("future-provider")).toBe(false);
    expect(PI_REVIEWED_ONE_TOKEN_PROVIDERS).toEqual(
      expect.arrayContaining([
        { id: "kimi-coding", name: "Kimi For Coding" },
        { id: "moonshotai", name: "Moonshot AI (global Kimi Platform)" },
        { id: "moonshotai-cn", name: "Moonshot AI China (Kimi Platform)" },
      ]),
    );
  });
});
