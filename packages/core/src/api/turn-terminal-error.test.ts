import { describe, it, expect } from "@rstest/core";
import {
  TURN_END_STATUSES,
  turnTerminalError,
  type ErrorBlock,
  type ResultBlock,
} from "@rome/api-types/trace-segments";

const errorBlock = (error: string): ErrorBlock => ({ type: "error", error });
const resultBlock = (content = "done"): ResultBlock => ({ type: "result", content });

describe("TURN_END_STATUSES", () => {
  it("is the closed turn-end status set", () => {
    expect([...TURN_END_STATUSES].sort()).toEqual(["completed", "error", "interrupted"]);
  });
});

describe("turnTerminalError", () => {
  it("returns the message only when the turn errored and its last terminal is an error", () => {
    expect(turnTerminalError(errorBlock("Access token expired"), "error")).toBe(
      "Access token expired",
    );
  });

  it("returns null when the error status closes over a non-error terminal", () => {
    // A relayed subagent error can land ahead of the owner's completed result;
    // the last terminal is that result, so the turn reports no error.
    expect(turnTerminalError(resultBlock(), "error")).toBeNull();
  });

  it("returns null when the turn completed even if the last terminal is an error", () => {
    expect(turnTerminalError(errorBlock("boom"), "completed")).toBeNull();
  });

  it("returns null when the turn was interrupted over an error terminal", () => {
    expect(turnTerminalError(errorBlock("Request was aborted"), "interrupted")).toBeNull();
  });

  it("returns null when there is no terminal block or no status", () => {
    expect(turnTerminalError(undefined, "error")).toBeNull();
    expect(turnTerminalError(null, "error")).toBeNull();
    expect(turnTerminalError(errorBlock("boom"), undefined)).toBeNull();
  });
});
