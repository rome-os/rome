import { describe, expect, it } from "@rstest/core";
import {
  type BaselineScenario,
  type CheckInput,
  answeredInline,
  cardRules,
  fridayOnly,
  shownAfter,
} from "./baseline-checks.js";
import {
  chineseStyle,
  conclusionIn,
  emojiCount,
  exactSpecifics,
  noTaskChatPointer,
  noTrailingOffer,
  oneEmoji,
  specificsOf,
  thanksWithoutEyes,
} from "./baseline-rules.js";
import { CARD_SCENARIOS } from "./baseline-scenarios-cards.js";
import type { TimedTurn } from "./timing.js";
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
  cardsAfter: saidAfter.map(() => []),
  reactions: saidAfter.map(() => null),
  said: saidAfter.flat(),
  shown: saidAfter.flat(),
  tasks: [],
  conclusions: [],
});

describe("exactSpecifics", () => {
  const conclusion =
    "PR #2392 ships in 1.1.209 (commit 5b1f1da52): see https://github.com/rome-os/rome/pull/2392. Cheapest ¥4,380, 6.1 h of sleep, 12 km, 3 options.";

  it("finds each URL, PR number, version, hex id and measured number once, and no small integer", () => {
    expect(specificsOf(conclusion)).toEqual([
      "https://github.com/rome-os/rome/pull/2392",
      "5b1f1da52",
      "#2392",
      "1.1.209",
      "4,380",
      "6.1",
      "12",
    ]);
  });

  it("finds a UUID, a v-prefixed version with a suffix, and no part of a URL twice", () => {
    expect(
      specificsOf(
        "Card 2a6c1fea-a43d-4057-ae8d-bc5f82d9fed2, release v2.0.1-rc.1, https://x.example/v1.2.3/a.",
      ),
    ).toEqual([
      "https://x.example/v1.2.3/a",
      "2a6c1fea-a43d-4057-ae8d-bc5f82d9fed2",
      "v2.0.1-rc.1",
    ]);
  });

  it("passes when the Concierge's words keep every specific verbatim", () => {
    expect(
      exactSpecifics(
        [conclusion],
        [
          "PR #2392 is in 1.1.209 (5b1f1da52), https://github.com/rome-os/rome/pull/2392. Flights from ¥4,380; sleep 6.1 小时; 12 km.",
        ],
        false,
      ),
    ).toEqual([]);
  });

  it("names each specific the Concierge changed or dropped", () => {
    expect(
      exactSpecifics(
        [conclusion],
        ["PR 2392 is in 1.1.210 (5b1f1da52), see the PR. Flights from ¥4380; sleep 6.1 h; 12 km."],
        false,
      ),
    ).toEqual([
      'rule: result drops "https://github.com/rome-os/rome/pull/2392" from the conclusion',
      'rule: result drops "#2392" from the conclusion',
      'rule: result drops "1.1.209" from the conclusion',
      'rule: result drops "4,380" from the conclusion',
    ]);
  });

  it("skips a result sent as a forwarded card, a conclusion with no news, and no conclusion", () => {
    expect(exactSpecifics([conclusion], ["Done."], true)).toEqual([]);
    expect(exactSpecifics(["Nothing to report."], ["Done."], false)).toEqual([]);
    expect(exactSpecifics([], ["Done."], false)).toEqual([]);
  });

  it("reads the last conclusion section of an answer, closed or not", () => {
    expect(
      conclusionIn(
        "Details.\n<!-- rome:conclusion -->\nold\n<!-- /rome:conclusion -->\n<!-- rome:conclusion -->\nFound 1.2.3.\n<!-- /rome:conclusion -->",
      ),
    ).toBe("Found 1.2.3.");
    expect(conclusionIn("<!-- rome:conclusion -->\nNo close")).toBe("No close");
    expect(conclusionIn("No section.")).toBeNull();
  });
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

describe("cards", () => {
  const withCards = (cardsAfter: string[][]): CheckInput => ({
    ...input(cardsAfter.map(() => ["ok."])),
    cardsAfter,
  });
  const scenario = (row: "chat" | "cards"): BaselineScenario => ({
    id: "x",
    row,
    lang: "en",
    about: "",
    steps: [],
    check: () => [],
    rubric: "",
  });

  it("flags a card for a greeting, and more than one card in a reply", () => {
    expect(cardRules(scenario("chat"), withCards([["Morning"]]))).toEqual([
      "card: 1 card(s) in a chat scenario",
    ]);
    expect(cardRules(scenario("cards"), withCards([["a", "b"]]))).toEqual([
      "card: 2 cards after step 1",
    ]);
    expect(cardRules(scenario("cards"), withCards([["a"]]))).toEqual([]);
  });

  it("fails a card scenario answered without a card", () => {
    const itinerary = CARD_SCENARIOS.find((s) => s.id === "card-itinerary");
    const plain = input([["Day 1: Belém. Day 2: Alfama."]]);
    expect(itinerary?.check(plain)).toContain("step 1: no card");
    // A card alone answers the step.
    const carded = withCards([["Day 1: Belém. Day 2: Alfama."]]);
    const turn = { tools: {} } as unknown as TimedTurn;
    expect(itinerary?.check({ ...carded, steps: [turn], saidAfter: [[]], said: [] })).toEqual([]);
  });

  it("counts a card's plain text as the answer in the generic checks", () => {
    const turn = { tools: {} } as unknown as TimedTurn;
    const cardOnly: CheckInput = {
      ...input([[]]),
      steps: [turn],
      cardsAfter: [["Closed on Tuesday"]],
      shown: ["Closed on Tuesday"],
    };
    expect(answeredInline(cardOnly, 0)).toEqual([]);
    expect(answeredInline({ ...cardOnly, cardsAfter: [[]], shown: [] }, 0)).toEqual([
      "step 1: no answer",
    ]);
    expect(shownAfter(cardOnly, 0)).toEqual(["Closed on Tuesday"]);
  });
});
