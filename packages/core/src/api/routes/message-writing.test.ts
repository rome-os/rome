import { describe, expect, it } from "@rstest/core";
import { messageWritingStart } from "./message-writing.js";

const delta = (tool: string, toolUseId = "call-1") => ({
  type: "tool_input_delta",
  tool,
  toolUseId,
  content: "{",
});

describe("messageWritingStart", () => {
  it("tells a message tool's call once, from its first input delta", () => {
    const told = new Set<string>();
    expect(messageWritingStart(delta("say"), told)).toBe("call-1");
    expect(messageWritingStart(delta("say"), told)).toBeNull();
    expect(messageWritingStart(delta("mcp__rome__chat_forward", "call-2"), told)).toBe("call-2");
    expect(messageWritingStart(delta("core:say", "call-3"), told)).toBe("call-3");
  });

  it("tells nothing for a work call or any other event", () => {
    const told = new Set<string>();
    expect(messageWritingStart(delta("web_search"), told)).toBeNull();
    expect(messageWritingStart(delta("essay"), told)).toBeNull();
    expect(messageWritingStart({ type: "text_delta" }, told)).toBeNull();
    expect(told.size).toBe(0);
  });
});
