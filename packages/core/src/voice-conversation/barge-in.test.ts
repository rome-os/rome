import { describe, expect, it } from "@rstest/core";
import { isLateEcho } from "./barge-in.js";

describe("late echo", () => {
  it("is Rome's last sentence, or its last few, whole", () => {
    const said = ["今天晴。", "明天下雨。"];
    expect(isLateEcho("明天下雨", said)).toBe(true);
    expect(isLateEcho("今天晴，明天下雨。", said)).toBe(true);
    expect(isLateEcho("Let me check", ["Let me check."])).toBe(true);
  });

  it("is not part of a sentence, an older sentence alone, or nothing", () => {
    const said = ["要订上午的航班，还是下午的航班？"];
    expect(isLateEcho("下午的航班", said)).toBe(false);
    expect(isLateEcho("今天晴", ["今天晴。", "明天下雨。"])).toBe(false);
    expect(isLateEcho("", said)).toBe(false);
    expect(isLateEcho("。", said)).toBe(false);
  });

  it("takes what Rome played since the turn began, after whole sentences or alone", () => {
    const said = ["我查一下。"];
    expect(isLateEcho("我查一下。今天晴", said, ["今天晴。"])).toBe(true);
    expect(isLateEcho("今天晴", said, ["今天晴。"])).toBe(true);
    expect(isLateEcho("查一下", said, ["今天晴。"])).toBe(false);
    expect(isLateEcho("我查一下明天", said, ["今天晴。"])).toBe(false);
  });
});
