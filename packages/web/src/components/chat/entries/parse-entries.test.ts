import { describe, expect, it } from "@rstest/core";
import { parseEntries } from "./parse-entries";

describe("parseEntries", () => {
  it("degrades non-array content to one text part", () => {
    expect(parseEntries("hello")).toEqual([{ type: "text", content: "hello" }]);
    expect(parseEntries("42")).toEqual([{ type: "text", content: "42" }]);
  });

  it("drops or repairs malformed client-posted parts", () => {
    const content = JSON.stringify([
      null,
      "text",
      { type: "text" },
      { type: "interaction_result", toolUseId: "t1", output: null },
      { type: "interaction_result", output: {} },
      { type: "text", content: "kept" },
      { type: "interaction_result", toolUseId: "t2", output: { dismissed: true } },
    ]);
    expect(parseEntries(content)).toEqual([
      { type: "interaction_result", toolUseId: "t1", output: {} },
      { type: "text", content: "kept" },
      { type: "interaction_result", toolUseId: "t2", output: { dismissed: true } },
    ]);
  });
});
