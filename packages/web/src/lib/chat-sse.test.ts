import { describe, expect, it } from "@rstest/core";
import { parseSSEEvents } from "./chat-sse";

describe("parseSSEEvents", () => {
  it("parses a single event with explicit event + data lines", () => {
    expect(parseSSEEvents("event: done\ndata: {}\n\n")).toEqual([{ event: "done", data: "{}" }]);
  });

  it("defaults the event name to 'message' when only data is present", () => {
    expect(parseSSEEvents("data: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
  });

  it("parses multiple events separated by blank lines", () => {
    expect(parseSSEEvents("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")).toEqual([
      { event: "a", data: "1" },
      { event: "b", data: "2" },
    ]);
  });

  it("joins multi-line data: fields with newlines (per the EventSource spec)", () => {
    expect(parseSSEEvents("event: chunk\ndata: line-1\ndata: line-2\n\n")).toEqual([
      { event: "chunk", data: "line-1\nline-2" },
    ]);
  });

  it("ignores whitespace-only fragments and drops events with empty data", () => {
    expect(parseSSEEvents("\n\nevent: empty\n\n")).toEqual([]);
  });
});
