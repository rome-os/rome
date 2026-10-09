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

  it("drops card parts missing the fields their kind requires", () => {
    const card = { type: "approval_card", approvalId: "a1", actionName: "send", status: "pending" };
    const content = JSON.stringify([
      card,
      { type: "pending_interaction", toolUseId: "t1", appId: "app" },
      { type: "routine_draft_card", toolUseId: "t2" },
      { ...card, preview: { kind: "generic", title: "T", summary: "S" } },
      { type: "plan_update" },
    ]);
    expect(parseEntries(content)).toEqual([
      { ...card, preview: { kind: "generic", title: "T", summary: "S" } },
      { type: "plan_update" },
    ]);
  });
});
