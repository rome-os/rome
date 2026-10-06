import { describe, expect, it } from "@rstest/core";
import { chooseConnection, connectionRefusalMessage } from "./index.js";

// The rule a send or a history read on a channel picks its Connection by,
// shared by the channels service and the actions that check before asking it.
describe("chooseConnection", () => {
  it("takes the channel's only Connection, or the one named among several", () => {
    expect(chooseConnection(["c-1"])).toEqual({ connectionId: "c-1" });
    expect(chooseConnection(["c-1", "c-2"], "c-2")).toEqual({ connectionId: "c-2" });
  });

  it("refuses rather than guessing", () => {
    expect(chooseConnection([])).toEqual({ refused: "none" });
    expect(chooseConnection(["c-1", "c-2"])).toEqual({ refused: "several" });
    expect(chooseConnection(["c-1"], "c-9")).toEqual({ refused: "not-backing" });
  });

  it("says each refusal the way the channels service always has", () => {
    expect(connectionRefusalMessage("discord", "none")).toBe(
      'No Talk connection registered for "discord"',
    );
    expect(connectionRefusalMessage("discord", "several")).toBe(
      'Channel "discord" has multiple connections; connectionId is required',
    );
    expect(connectionRefusalMessage("discord", "not-backing", "c-9")).toBe(
      'Connection "c-9" does not provide channel "discord"',
    );
  });
});
