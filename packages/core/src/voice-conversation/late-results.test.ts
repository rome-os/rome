import { describe, expect, it } from "@rstest/core";
import { lateMessage, offerLine, offerNote } from "./late-results.js";

describe("late messages", () => {
  it("keys a report by the task it replies to, the task chat its card shows, or its turn", () => {
    const text = (content: string) => ({ type: "text", content });
    expect(
      lateMessage(
        JSON.stringify([
          { type: "reply_to", messageId: "m1", author: "guardian", text: "q" },
          text("done"),
        ]),
        "t1",
      ),
    ).toMatchObject({ key: "start:m1", replyTo: "m1", task: true, text: "done" });
    expect(
      lateMessage(
        JSON.stringify([{ type: "task_chat", chatId: "c1", title: "Fix CI", show: "ask" }]),
        "t2",
      ),
    ).toMatchObject({ key: "task:c1", name: "Fix CI", task: true, events: [{ type: "shown" }] });
    expect(lateMessage(JSON.stringify([text("hello")]), "t3")).toMatchObject({
      key: "turn:t3",
      task: false,
    });
    expect(lateMessage(JSON.stringify([]), "t4")).toBeNull();
    expect(lateMessage("not json", "t5")).toBeNull();
  });

  it("asks by the task's name in the guardian's language", () => {
    expect(offerLine({ name: "**夏威夷酒店**", task: true }, "zh")).toBe(
      "「夏威夷酒店」有结果了，要听吗？",
    );
    expect(offerLine({ name: null, task: false }, "zh")).toBe("有新消息了，要听吗？");
    expect(offerLine({ name: "Fix CI", task: true }, "en")).toBe(
      "Fix CI has a result. Want to hear it?",
    );
    expect(offerLine({ name: "x".repeat(40), task: true }, "en")).toMatch(/^x{24}… has a result/);
  });

  it("tells the agent what Rome asked and what the result says, for it to read the answer", () => {
    const message = lateMessage(
      JSON.stringify([
        { type: "text", content: "三家酒店都订得到。" },
        { type: "widget", widget: "card" },
      ]),
      "t1",
      "msg-1",
    );
    if (!message) throw new Error("expected a late message");
    const note = offerNote(message, "「夏威夷酒店」有结果了，要听吗？");
    expect(note).toContain('Rome asked the guardian aloud: "「夏威夷酒店」有结果了，要听吗？"');
    expect(note).toContain("(message msg-1 in this chat)");
    expect(note).toContain("三家酒店都订得到。\n[Something the chat shows, such as a card]");
    expect(note).toMatch(/If they want to hear it, tell them the whole result/);
    expect(note).toMatch(/If they decline or want it later/);
    expect(note).toMatch(/do each, in the order they asked/);
  });
});
