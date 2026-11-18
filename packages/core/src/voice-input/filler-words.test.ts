import { describe, expect, it } from "@rstest/core";
import { createFillerFilter, removeFillerWords } from "./filler-words.js";

describe("removeFillerWords", () => {
  it.each([
    ["嗯，我觉得可以", "我觉得可以"],
    ["嗯嗯，好的", "好的"],
    ["我觉得，呃，这个方案不错", "我觉得，这个方案不错"],
    ["我觉得嗯这个方案不错", "我觉得这个方案不错"],
    ["我觉得，嗯。", "我觉得。"],
    ["嗯。我们开始吧", "我们开始吧"],
    ["啊，原来是这样", "原来是这样"],
    ["那个 um 功能", "那个功能"],
    ["这个um功能", "这个功能"],
    ["Um, so I think we should ship it.", "So I think we should ship it."],
    ["Hmm, let me think.", "Let me think."],
    ["I uh think so", "I think so"],
    ["I think, um, that works", "I think, that works"],
    ["I think um.", "I think."],
    ["Done. Uh. Next step", "Done. Next step"],
    ["Um, uh, I think so", "I think so"],
    ["Uh, um, yes", "Yes"],
    ["Hmm, um, okay.", "Okay."],
    ["So, um, uh, yes", "So, yes"],
    ["打开 Rome，uh，然后 deploy", "打开 Rome，然后 deploy"],
    ["嗯", ""],
  ])("drops the filler in %j", (spoken, written) => {
    expect(removeFillerWords(spoken)).toBe(written);
  });

  it.each([
    "好啊，没问题",
    "是啊",
    "这个额度不够",
    "额外的费用",
    "唔该晒",
    "啊呀",
    "My umbrella is here",
    "Uh-oh, that broke",
    "The UM campus",
    "Ahh, I see",
    "hum along",
    "Mm, 5 mm wide",
    "嗯？我没听清",
    "Hmm? Say that again",
    "啊？你说什么",
    "嗯哼，好的",
  ])("keeps %j", (text) => {
    expect(removeFillerWords(text)).toBe(text);
  });

  it("reads the text before it without changing it", () => {
    expect(removeFillerWords(" um, works", "I think it")).toBe(" works");
    expect(removeFillerWords("啊，好的", "可以")).toBe("啊，好的");
    expect(removeFillerWords("um plan", "The premi")).toBe("um plan");
  });
});

describe("createFillerFilter", () => {
  // What the client shows: settled text appended, pending text replaced.
  function show(updates: [string, string][]) {
    const filter = createFillerFilter();
    let settled = "";
    let pending = "";
    const shown: string[] = [];
    for (const [s, p] of updates) {
      const out = filter.update(s, p);
      settled += out.settled;
      pending = out.pending;
      shown.push(settled + pending);
    }
    return shown;
  }

  it("passes text without fillers through unchanged", () => {
    const filter = createFillerFilter();
    expect(filter.update("Hello", " wor")).toEqual({ settled: "Hello", pending: " wor" });
    expect(filter.update(" world", "")).toEqual({ settled: " world", pending: "" });
    expect(filter.update("", "")).toEqual({ settled: "", pending: "" });
  });

  it("drops a filler split across updates", () => {
    expect(
      show([
        ["嗯", ""],
        ["，", "我"],
        ["我觉得", ""],
      ]),
    ).toEqual(["", "我", "我觉得"]);
    expect(
      show([
        ["U", "m"],
        ["m", ","],
        [",", " so"],
        [" so", ""],
      ]),
    ).toEqual(["", "", "So", "So"]);
  });

  it("drops the pause before a filler that ends the sentence", () => {
    expect(
      show([
        ["我觉得，", ""],
        ["嗯", ""],
        ["。", ""],
        ["好的", ""],
      ]),
    ).toEqual(["我觉得，", "我觉得", "我觉得。", "我觉得。好的"]);
  });

  it("keeps a word that only starts like a filler", () => {
    expect(
      show([
        ["My u", ""],
        ["mbrella", ""],
      ]),
    ).toEqual(["My u", "My umbrella"]);
    expect(
      show([
        ["好", ""],
        ["啊", ""],
        ["，走吧", ""],
      ]),
    ).toEqual(["好", "好啊", "好啊，走吧"]);
  });

  it("keeps an English word split before a filler-like ending", () => {
    expect(
      show([
        ["The premi", ""],
        ["um plan", ""],
        [" works.", ""],
      ]).at(-1),
    ).toBe("The premium plan works.");
    expect(
      show([
        ["The alb", ""],
        ["um is", ""],
        [" out.", ""],
      ]).at(-1),
    ).toBe("The album is out.");
    expect(
      show([
        ["Long t", ""],
        ["erm goal", ""],
      ]).at(-1),
    ).toBe("Long term goal");
    expect(
      show([
        ["I visited the muse", ""],
        ["um yesterday.", ""],
      ]).at(-1),
    ).toBe("I visited the museum yesterday.");
    expect(show([["The premi", "um plan"]])).toEqual(["The premium plan"]);
  });

  it("shows a dictation that is nothing but fillers as said", () => {
    const yes = createFillerFilter();
    yes.update("嗯", "");
    yes.update("嗯。", "");
    expect(yes.finish()).toEqual({ settled: "嗯嗯。", pending: "" });

    const asked = createFillerFilter();
    expect(asked.update("Hmm", "?")).toEqual({ settled: "", pending: "Hmm?" });
    expect(asked.finish()).toBeNull();

    const spoken = createFillerFilter();
    spoken.update("嗯，", "");
    spoken.update("好的", "");
    expect(spoken.finish()).toBeNull();
  });

  it("handles a long run of filler-like sounds quickly", () => {
    const started = performance.now();
    const said = `${"u ".repeat(40)}okay`;
    expect(createFillerFilter().update(said, "")).toEqual({ settled: said, pending: "" });
    // Without a single way to match each sound, this run takes hours.
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("only appends to settled text", () => {
    const filter = createFillerFilter();
    const settled = ["Hmm", ", ", "I ", "uh", " think", " um", ".", " Yes"].map(
      (part) => filter.update(part, "").settled,
    );
    expect(settled.join("") + filter.update("", "").pending).toBe("I think. Yes");
  });
});
