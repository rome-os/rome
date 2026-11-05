import { describe, expect, it } from "@rstest/core";
import { turnFacts, withTurnExecution, withTurnLinks } from "./turn-context.js";

describe("turn facts", () => {
  // No telemetry runs in these tests, so no OTel context manager is installed.
  it("reach the turn sent inside them without telemetry", () => {
    const execution = { executionId: "exec-1" };
    const links = [{ context: { traceId: "t", spanId: "s", traceFlags: 1 } }];
    const seen = withTurnExecution(execution, () => withTurnLinks(links, () => turnFacts()));
    expect(seen).toEqual({ execution, links });
  });

  it("are gone outside the call that set them", () => {
    withTurnExecution({ executionId: "exec-1" }, () => undefined);
    expect(turnFacts()).toEqual({});
  });
});
