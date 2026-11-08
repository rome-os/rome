import { describe, expect, it } from "@rstest/core";
import { codexStop } from "./stop.js";

describe("codexStop", () => {
  it("maps each turn status", () => {
    expect(codexStop("completed")).toEqual({ reason: "completed", raw: "completed" });
    expect(codexStop("interrupted")).toEqual({ reason: "interrupted", raw: "interrupted" });
    expect(codexStop("failed")).toEqual({ reason: "error", raw: "failed" });
    expect(codexStop("inProgress")).toEqual({ reason: "other", raw: "inProgress" });
    expect(codexStop(undefined)).toEqual({ reason: "other" });
  });

  it("reports a failed turn as an error whatever its status", () => {
    expect(codexStop("failed", true)).toEqual({ reason: "error", raw: "failed" });
    expect(codexStop("completed", true)).toEqual({ reason: "error", raw: "completed" });
    expect(codexStop(undefined, true)).toEqual({ reason: "error" });
    expect(codexStop("interrupted", true)).toEqual({ reason: "error", raw: "interrupted" });
  });
});
