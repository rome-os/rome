import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { settlePresses } from "./check-presses";
import { beginPending, getPending, resetPending } from "./task-pending";

const phases = () => Object.fromEntries([...getPending()].map(([id, press]) => [id, press.phase]));

beforeEach(() => resetPending());
afterEach(() => resetPending());

describe("settlePresses", () => {
  it("marks only the press whose turn the server says ended, and leaves the queued one pending", () => {
    beginPending("first", "stop", 1, "input-first", "concierge");
    beginPending("second", "archive", 1, "input-second", "concierge");
    settlePresses({ sessionId: "concierge", inputIds: ["input-first"] });
    expect(phases()).toEqual({ first: "unchanged", second: "pending" });
  });

  it("reads a press only in the Concierge chat it went to", () => {
    beginPending("first", "stop", 1, "input-first", "topic-1");
    settlePresses({ sessionId: "concierge", inputIds: ["input-first"] });
    expect(phases()).toEqual({ first: "pending" });
    settlePresses({ sessionId: "topic-1", inputIds: ["input-first"] });
    expect(phases()).toEqual({ first: "unchanged" });
  });
});
