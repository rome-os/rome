import { describe, expect, it } from "@rstest/core";
import { actionError } from "./actions.js";

describe("action failure diagnostics", () => {
  it("omits details when no diagnostics are present", () => {
    expect(actionError("unsupported_action", "Unavailable.", {})).toEqual({
      type: "response",
      ok: false,
      error: { code: "unsupported_action", message: "Unavailable." },
    });
  });

  it("discards oversized or circular diagnostics while retaining the failure and safety signals", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const details of [{ text: "x".repeat(8193) }, circular]) {
      expect(actionError("unknown_outcome", "Do not replay.", details)).toEqual(
        actionError("unknown_outcome", "Do not replay."),
      );
    }
    const circularWithSafety: Record<string, unknown> = {
      effectStatus: "unknown",
      terminalCause: "connection_lost",
      stopConfirmed: true,
    };
    circularWithSafety.self = circularWithSafety;
    for (const details of [
      {
        effectStatus: "unknown",
        terminalCause: "connection_lost",
        stopConfirmed: true,
        text: "x".repeat(8193),
      },
      circularWithSafety,
    ]) {
      expect(actionError("unknown_outcome", "Do not replay.", details)).toEqual({
        type: "response",
        ok: false,
        error: {
          code: "unknown_outcome",
          message: "Do not replay.",
          details: {
            effectStatus: "unknown",
            terminalCause: "connection_lost",
            stopConfirmed: true,
          },
        },
      });
    }
  });
});
