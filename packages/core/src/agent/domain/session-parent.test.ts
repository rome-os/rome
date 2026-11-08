import { describe, expect, it } from "@rstest/core";
import {
  parentTurnSession,
  rootSession,
  storeForkParent,
  storeSubagentParent,
  walkToRoot,
} from "./session-parent.js";

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

describe("parentTurnSession", () => {
  it("is the named parent for a subagent's or a fork's session, and none for any other", () => {
    expect(parentTurnSession("subagent", "p")).toBe("p");
    expect(parentTurnSession("fork", "p")).toBe("p");
    expect(parentTurnSession("chat", "p")).toBeNull();
    expect(parentTurnSession("fork", null)).toBeNull();
  });
});

describe("rootSession", () => {
  const dashboard = (parents: Record<string, string | null>) => {
    const reads: string[] = [];
    return {
      reads,
      sessions: {
        parentSession: async (id: string) => {
          reads.push(id);
          return id in parents ? parents[id] : undefined;
        },
      },
    };
  };

  it("is the session itself when it has no parent turn", async () => {
    const { sessions } = dashboard({ chat: null });
    expect(await rootSession(sessions, "chat")).toBe("chat");
  });

  it("walks up the parent turns to the first session that has none", async () => {
    const { sessions } = dashboard({ sub: "fork", fork: "chat", chat: null });
    expect(await rootSession(sessions, "sub")).toBe("chat");
  });

  it("stops at the last session it found when a parent's session is gone", async () => {
    const { sessions } = dashboard({ sub: "gone" });
    expect(await rootSession(sessions, "sub")).toBe("sub");
  });

  it("is null when there is no such session", async () => {
    const { sessions } = dashboard({});
    expect(await rootSession(sessions, "nope")).toBeNull();
  });

  it("stops after 16 parents, so a cycle ends", async () => {
    const chain: Record<string, string | null> = {};
    for (let i = 0; i < 20; i++) chain[`s${i}`] = `s${i + 1}`;
    chain.s20 = null;
    const { sessions, reads } = dashboard(chain);
    expect(await rootSession(sessions, "s0")).toBe("s16");
    expect(reads).toHaveLength(17);
    const cycle = dashboard({ a: "b", b: "a" });
    expect(["a", "b"]).toContain(await rootSession(cycle.sessions, "a"));
  });
});
