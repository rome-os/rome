import { describe, expect, it, rs } from "@rstest/core";
import { MessageStatusTracker } from "./message-status.js";

function tracker(inherited = false) {
  const repo = {
    markWorking: rs.fn(async () => undefined),
    markReacted: rs.fn(async () => undefined),
    anyInheritedWorking: rs.fn(async () => inherited),
  };
  const status = new MessageStatusTracker(() => repo as never, 0);
  const signs: string[] = [];
  status.onSign((chatId, sign) => signs.push(`${chatId}:${sign}`));
  return { status, repo, signs };
}

describe("MessageStatusTracker signs", () => {
  it("tells working once a turn's second working call marks its messages", async () => {
    const { status, signs } = tracker();
    status.taken("chat", "m1", "turn");
    void status.toolCalled("chat", "turn", "mcp__rome__execute_action", "a");
    await status.toolCalled("chat", "turn", "mcp__rome__execute_action", "b");
    expect(signs).toEqual(["chat:working"]);
  });

  it("tells no working when work handed on from an earlier turn carries the chat", async () => {
    const { status, signs } = tracker(true);
    status.taken("chat", "m1", "turn");
    void status.toolCalled("chat", "turn", "Read", "a");
    await status.toolCalled("chat", "turn", "Read", "b");
    expect(signs).toEqual([]);
  });

  it("tells a reaction", async () => {
    const { status, signs } = tracker();
    await status.reactedTo("chat", "m1");
    expect(signs).toEqual(["chat:reacted"]);
  });
});
