import { describe, expect, it } from "@rstest/core";
import {
  isRomeCreditsExhaustedError,
  isRomeCreditsModelNotServedError,
} from "./rome-credits-error.js";

describe("Rome credits error", () => {
  it("recognizes the gateway's model_not_allowed by code or message", () => {
    expect(
      isRomeCreditsModelNotServedError({
        error: { code: "model_not_allowed" },
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } },
      }),
    ).toBe(true);
    expect(isRomeCreditsModelNotServedError({ error: { code: "model_not_allowed" } })).toBe(false);
    expect(
      isRomeCreditsModelNotServedError({
        message:
          "unexpected status 403 Forbidden: This model is not available from Rome credits., url: http://test",
      }),
    ).toBe(true);
    expect(isRomeCreditsModelNotServedError({ message: "403 Forbidden" })).toBe(false);
  });

  it("recognizes #124's insufficient_credits 402", () => {
    expect(
      isRomeCreditsExhaustedError({
        message: "Rome credits are used up. insufficient_credits",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } },
      }),
    ).toBe(true);
  });

  it("recognizes the 402 message preserved by bundled Codex", () => {
    expect(
      isRomeCreditsExhaustedError({
        message:
          "unexpected status 402 Payment Required: Rome credits are used up., url: http://test",
        codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 402 } },
        additionalDetails: null,
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
