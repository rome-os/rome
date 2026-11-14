import { describe, expect, it } from "@rstest/core";
import { MessageWriting, messageWritingModeOf } from "./message-writing.js";

const delta = (tool: string, toolUseId = "call-1") => ({
  type: "tool_input_delta",
  tool,
  toolUseId,
  content: "{",
});
const use = (tool: string, id = "call-1") => ({ type: "tool_use", tool, id });

describe("MessageWriting", () => {
  it("writes from a message call's first input until the call lands whole", () => {
    const writing = new MessageWriting("exact");
    expect(writing.on(delta("say"))).toBe(true);
    expect(writing.on(delta("say"))).toBeNull();
    expect(writing.on(use("say"))).toBe(false);
    // A late delta of a call that landed opens nothing.
    expect(writing.on(delta("say"))).toBeNull();
    expect(writing.on(delta("mcp__rome__chat_forward", "call-2"))).toBe(true);
    expect(writing.on(delta("core:say", "call-3"))).toBeNull();
    expect(writing.on(use("chat_forward", "call-2"))).toBeNull();
    expect(writing.on(use("say", "call-3"))).toBe(false);
  });

  it("writes nothing for a work call, and stops when the turn ends", () => {
    const writing = new MessageWriting("exact");
    expect(writing.on(delta("web_search"))).toBeNull();
    expect(writing.on(delta("essay"))).toBeNull();
    expect(writing.on({ type: "thinking" })).toBeNull();
    expect(writing.on(delta("say"))).toBe(true);
    expect(writing.on({ type: "result" })).toBe(false);
  });

  it("never writes on a simulated turn: no inference from its events", () => {
    const writing = new MessageWriting("simulated");
    expect(writing.on(delta("say"))).toBeNull();
    expect(writing.on({ type: "thinking" })).toBeNull();
    expect(writing.writing).toBe(false);
  });

  it("is exact on Claude only", () => {
    expect(messageWritingModeOf("anthropic")).toBe("exact");
    expect(messageWritingModeOf("openai")).toBe("simulated");
    expect(messageWritingModeOf(undefined)).toBe("simulated");
  });
});
