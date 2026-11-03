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

  it("drops parts of unknown kinds and cards missing required fields", () => {
    const card = { type: "approval_card", approvalId: "a1", actionName: "send", status: "pending" };
    const content = JSON.stringify([
      card,
      { type: "pending_interaction", toolUseId: "t1", appId: "app" },
      { type: "routine_draft_card", toolUseId: "t2" },
      { ...card, preview: { kind: "generic", title: "T", summary: "S" } },
      { type: "tool_use" },
    ]);
    expect(parseEntries(content)).toEqual([
      { ...card, preview: { kind: "generic", title: "T", summary: "S" } },
    ]);
  });

  it("keeps a reply part and drops one without its quote", () => {
    const reply = { type: "reply_to", messageId: "m1", author: "agent", name: "Rome", text: "Hi" };
    const content = JSON.stringify([
      reply,
      { type: "reply_to", messageId: "m2", author: "agent" },
      { type: "text", content: "answer" },
    ]);

    expect(parseEntries(content)).toEqual([reply, { type: "text", content: "answer" }]);
  });
});
