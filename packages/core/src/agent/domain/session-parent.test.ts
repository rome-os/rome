import { describe, expect, it } from "@rstest/core";
import { storeForkParent, storeSubagentParent, walkToRoot } from "./session-parent.js";

// Stored rows resolve by these exact strings, so a change to their form
// strands every existing subagent and fork session.
describe("the stored parent link", () => {
  it("writes a subagent session under its parent, fresh each time", () => {
    expect(storeSubagentParent("webchat:chat-1")).toMatch(
      /^webchat:chat-1:subagent:[0-9a-f-]{36}$/,
    );
    expect(storeSubagentParent("webchat:chat-1")).not.toBe(storeSubagentParent("webchat:chat-1"));
  });

  it("writes a fork's subagent sessions under the fork", () => {
    expect(storeForkParent("webchat:chat-1", "fork-1")).toBe("webchat:chat-1#fork:fork-1");
  });

  it("walks up to the root session, listing the forks passed", () => {
    const stored = storeSubagentParent(
      storeForkParent(storeSubagentParent(storeForkParent("webchat:chat-1", "f1")), "f2"),
    );
    expect(walkToRoot(stored)).toEqual({
      stored: "webchat:chat-1",
      hasParent: true,
      forkSessionIds: ["f2", "f1"],
    });
  });

  it("stops at once at a root session", () => {
    expect(walkToRoot("slack:C1:1700000000.1")).toEqual({
      stored: "slack:C1:1700000000.1",
      hasParent: false,
      forkSessionIds: [],
    });
  });
});
