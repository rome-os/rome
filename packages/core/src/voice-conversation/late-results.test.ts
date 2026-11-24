import { describe, expect, it } from "@rstest/core";
import { isYes, lateMessage, offerLine } from "./late-results.js";

describe("late messages", () => {
  it("takes a short yes as a yes, and anything else as a turn", () => {
    for (const yes of [
      "要",
      "好",
      "好的。",
      "嗯嗯",
      "念吧",
      "好，念吧",
      "要听",
      "可以",
      "来吧",
      "Yes",
      "yeah, go ahead",
      "OK read it",
    ]) {
      expect(isYes(yes)).toBe(true);
    }
    for (const other of [
      "不要",
      "不用了",
      "先不听",
      "要不明天再说吧",
      "好的谢谢你再帮我查一下",
      "no",
      "not now",
      "yes but first tell me the weather",
    ]) {
      expect(isYes(other)).toBe(false);
    }
  });

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
});
