import { describe, expect, it } from "@rstest/core";
import { describeToolSummary, toolStepDotClass } from "./ToolStepBlock";

const t = (key: string) => key;

describe("describeToolSummary", () => {
  it("uses WebSearch query from Claude Code input payloads", () => {
    expect(
      describeToolSummary(
        "WebSearch",
        { query: "top news and commentary May 23 2026" },
        null,
        false,
        t,
      ),
    ).toBe("top news and commentary May 23 2026");
  });

  it("uses WebSearch query from Codex output payloads when input query is empty", () => {
    expect(
      describeToolSummary(
        "WebSearch",
        { query: "" },
        { query: "today's top news May 24 2026 Reuters world US business technology commentary" },
        true,
        t,
      ),
    ).toBe("today's top news May 24 2026 Reuters world US business technology commentary");
  });

  it("prefers the first non-empty WebSearch query from input before output", () => {
    expect(
      describeToolSummary(
        "web_search",
        { query: "input query" },
        { query: "output query" },
        true,
        t,
      ),
    ).toBe("input query");
  });

  it("does not show a generic query label for Codex WebSearch while only empty input is available", () => {
    expect(describeToolSummary("WebSearch", { query: "" }, undefined, false, t)).toBeNull();
  });

  it("does not fall back to generic summaries when WebSearch has no non-empty query", () => {
    expect(
      describeToolSummary("WebSearch", { query: "   ", other: "fallback" }, { query: "" }, true, t),
    ).toBeNull();
  });
});

describe("toolStepDotClass", () => {
  it("uses the current yellow running dot when a pending tool call is not live", () => {
    expect(toolStepDotClass("running", false)).toBe("bg-warning");
  });

  it("uses a blinking blue dot when a pending tool call is live", () => {
    expect(toolStepDotClass("running", true)).toBe("animate-pulse bg-info");
  });

  it("does not change completed statuses for live traces", () => {
    expect(toolStepDotClass("ok", true)).toBe("bg-success");
  });
});
