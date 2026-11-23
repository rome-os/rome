import { describe, expect, it } from "@rstest/core";
import { enoughWords, isEcho } from "./barge-in.js";
import { createSentenceSplitter } from "./sentences.js";
import { createSpeakableFilter, plainSentence } from "./speakable.js";

/** What a reply says, fed in `chunk`-sized pieces as a stream would. */
function spoken(markdown: string, chunk = 3, language: "zh" | "en" = "zh"): string[] {
  const filter = createSpeakableFilter(language);
  const splitter = createSentenceSplitter();
  const sentences: string[] = [];
  for (let i = 0; i < markdown.length; i += chunk) {
    sentences.push(...splitter.push(filter.push(markdown.slice(i, i + chunk))));
  }
  sentences.push(...splitter.push(filter.end()), ...splitter.end());
  return sentences.map(plainSentence).filter(Boolean);
}

describe("speakable reply", () => {
  it("says prose sentence by sentence, in Chinese and English", () => {
    expect(spoken("好的，我看了一下。CI 已经过了！Next, merge it? Sure")).toEqual([
      "好的，我看了一下。",
      "CI 已经过了！",
      "Next, merge it?",
      "Sure",
    ]);
  });

  it("keeps numbers and versions whole", () => {
    expect(spoken("Rome 1.1.198 is up 3.5% today. Done.")).toEqual([
      "Rome 1.1.198 is up 3.5% today.",
      "Done.",
    ]);
  });

  it("points to the chat once for code and tables, and reads none of them", () => {
    const reply = [
      "改好了：",
      "```ts",
      "const a = 1;",
      "```",
      "| 项 | 值 |",
      "|---|---|",
      "| a | 1 |",
      "就这些。",
    ].join("\n");
    expect(spoken(reply)).toEqual(["改好了：", "详细内容在聊天里。", "就这些。"]);
    expect(spoken("```\ncode\n```", 5, "en")).toEqual(["The details are in the chat."]);
  });

  it("drops heading, list and emphasis marks, links' addresses and bare addresses", () => {
    const reply =
      "## 结论\n- **pr#2588** 已合并\n1. 看 [这个 PR](https://github.com/x/y) 和 `voice_mode`\n> 引用 https://a.b/c";
    expect(spoken(reply)).toEqual(["结论", "pr#2588 已合并", "看 这个 PR 和 voice_mode", "引用"]);
  });

  it("cuts a long run without full stops at a comma", () => {
    const clause = "这一段话没有句号但是有逗号，";
    const sentences = spoken(clause.repeat(8));
    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.every((s) => [...s].length <= 100)).toBe(true);
    expect(sentences.join("")).toBe(clause.repeat(8));
  });

  it("says nothing for punctuation alone", () => {
    expect(spoken("---\n\n***\n")).toEqual([]);
  });
});

describe("barge-in", () => {
  it.each([
    ["停一下", true],
    ["停一", false],
    ["wait stop", true],
    ["wait", false],
    ["嗯 OK", false],
    ["等等 wait a", true],
  ])("counts %j as speaking: %s", (heard, expected) => {
    expect(enoughWords(heard)).toBe(expected);
  });

  it("tells Rome's own words from the guardian's", () => {
    const said = "好的，我看了一下。CI 已经过了！";
    expect(isEcho("CI已经过了", said)).toBe(true);
    expect(isEcho("停一下", said)).toBe(false);
    expect(isEcho("", said)).toBe(false);
  });
});
