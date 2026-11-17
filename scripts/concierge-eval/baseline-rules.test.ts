import { describe, expect, it } from "@rstest/core";
import { type CheckInput, fridayOnly } from "./baseline-checks.js";
import {
  chineseStyle,
  emojiCount,
  noTaskChatPointer,
  noTrailingOffer,
  oneEmoji,
  thanksWithoutEyes,
} from "./baseline-rules.js";
import { LONG_SCENARIOS, renovationLog } from "./baseline-scenarios-long.js";

describe("oneEmoji", () => {
  it("counts a joined or varied emoji as one, and flags a second", () => {
    expect(emojiCount("Done ✅")).toBe(1);
    expect(emojiCount("❤️ and 👩‍💻")).toBe(2);
    expect(emojiCount("22.2 °C, 11:30 → fine")).toBe(0);
    expect(oneEmoji(["Morning! ☀️", "Done ✅ 🎉"])).toEqual(['rule: 2 emoji in "Done ✅ 🎉"']);
  });
});

describe("noTaskChatPointer", () => {
  it("flags a result that sends the owner to the task chat, not one that names it", () => {
    expect(noTaskChatPointer(["Full table is in the task chat."])).toHaveLength(1);
    expect(noTaskChatPointer(["See the task for details."])).toHaveLength(1);
    expect(noTaskChatPointer(["详情请查看任务。"])).toHaveLength(1);
    expect(noTaskChatPointer(["任务由一个 Agent 在它自己的任务聊天里完成。"])).toEqual([]);
    expect(noTaskChatPointer(["Closed on Tuesdays, 9:00–18:00."])).toEqual([]);
  });
});

describe("noTrailingOffer", () => {
  it("flags an answer that ends on a question or an offer", () => {
    expect(noTrailingOffer(["About 22.2 °C."], 0)).toEqual([]);
    expect(noTrailingOffer(["About 22.2 °C. Want me to convert more?"], 0)).toHaveLength(1);
    expect(noTrailingOffer(["11:30. Let me know if the flight moves."], 0)).toHaveLength(1);
    expect(noTrailingOffer(["约 22.2 °C。需要我再换算别的吗？"], 0)).toHaveLength(1);
    expect(noTrailingOffer(["Is it raining? Bring a coat."], 0)).toEqual([]);
    expect(noTrailingOffer([], 0)).toEqual([]);
  });
});

describe("thanksWithoutEyes", () => {
  it("flags the working status or a 👀 reaction on a thanks", () => {
    expect(thanksWithoutEyes({ workingMs: null }, "❤️", 1)).toEqual([]);
    expect(thanksWithoutEyes({ workingMs: 800 }, null, 1)).toHaveLength(1);
    expect(thanksWithoutEyes({ workingMs: null }, "👀", 1)).toHaveLength(1);
  });
});

describe("chineseStyle", () => {
  it("wants Chinese and full-width punctuation", () => {
    expect(chineseStyle(["交给一个 Agent 去做，完成后我转达结果。", "Porto", "11:30"])).toEqual([]);
    const half = chineseStyle(["大约 22.2 °C, 很舒服."]);
    expect(half).toHaveLength(1);
    expect(half[0]).toMatch(/half-width punctuation ", 很"/);
    expect(chineseStyle(["It is about 22.2 degrees today."])[0]).toMatch(/not Chinese/);
  });
});

const input = (saidAfter: string[][]): CheckInput => ({
  steps: saidAfter.map(() => null),
  turns: [],
  saidAfter,
  reactions: saidAfter.map(() => null),
  said: saidAfter.flat(),
  tasks: [],
});

describe("the multi-turn scenario", () => {
  const scenario = LONG_SCENARIOS.find((s) => s.id === "multi-turn");

  it("flags a late quick sum answered at length, and measures it", () => {
    const answers = Array.from({ length: 12 }, () => ["ok."]);
    answers[2] = ["45."];
    answers[9] = [`57. ${"Also, about your trip: ".repeat(10)}`];
    const notes = scenario?.check(input(answers)) ?? [];
    expect(notes.some((n) => n.startsWith("drift: step 10"))).toBe(true);
    expect(scenario?.measure?.(input(answers))).toMatchObject({
      probeEarlyChars: 3,
      probeLateChars: answers[9]?.[0]?.length,
    });
  });
});

describe("renovationLog", () => {
  it("is the same text every run, and hides the electrician in its first part", () => {
    expect(renovationLog(1, 2000)).toBe(renovationLog(1, 2000));
    expect(renovationLog(0, 5000)).toContain("Jonas Brandt");
    expect(renovationLog(1, 5000)).not.toContain("Jonas Brandt");
    expect(renovationLog(2, 45_000).length).toBeGreaterThanOrEqual(45_000);
  });
});

describe("fridayOnly", () => {
  it("flags any weekday but Friday for the dentist's day", () => {
    expect(fridayOnly(["Friday, Nov 20 at 15:30 with Dr. Weber."])).toEqual([]);
    expect(fridayOnly(["11月20日（周五）下午 3:30。"])).toEqual([]);
    expect(fridayOnly(["Thursday, Nov 20 at 15:30."])).toHaveLength(1);
    expect(fridayOnly(["11月20日（星期四）下午 3:30。"])).toHaveLength(1);
  });
});
