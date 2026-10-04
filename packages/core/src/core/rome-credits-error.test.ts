import { describe, expect, it } from "@rstest/core";
import { isRomeCreditsExhaustedError } from "./rome-credits-error.js";

describe("Rome credits error", () => {
  it("recognizes #124's insufficient_credits 402", () => {
    expect(
      isRomeCreditsExhaustedError({
        message: "Rome credits are used up. insufficient_credits",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } },
      }),
    ).toBe(true);
  });

  it("does not treat an unrelated 402 or bare code as exhausted credits", () => {
    expect(
      isRomeCreditsExhaustedError({
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } },
      }),
    ).toBe(false);
    expect(isRomeCreditsExhaustedError({ message: "insufficient_credits" })).toBe(false);
  });
});
