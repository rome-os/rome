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

  it("discards oversized or circular diagnostics while retaining the failure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const details of [{ text: "x".repeat(8193) }, circular]) {
      expect(actionError("unknown_outcome", "Do not replay.", details)).toEqual(
        actionError("unknown_outcome", "Do not replay."),
      );
    }
  });
});
