import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { errors, per100, tokens } from "./text.mjs";

describe("tokens", () => {
  it("ignores case, punctuation and spelling region in English", () => {
    assert.deepEqual(tokens("Travellers, don't forget: 3 bags!", "en"), [
      "travelers",
      "don't",
      "forget",
      "three",
      "bags",
    ]);
    assert.deepEqual(tokens("It's 21-year-old wine.", "en"), [
      "it's",
      "twenty",
      "one",
      "year",
      "old",
      "wine",
    ]);
  });

  it("counts Chinese by character and Latin words whole in mixed messages", () => {
    assert.deepEqual(tokens("我做dialogue system研究。", "mixed"), [
      "我",
      "做",
      "dialogue",
      "system",
      "研",
      "究",
    ]);
  });

  it("writes numbers the way Mandarin reads them", () => {
    assert.deepEqual(tokens("有15人，2024年", "zh"), [..."有十五人二零二四年"]);
    assert.deepEqual(tokens("１０５分", "zh"), [..."一百零五分"]);
  });
});

describe("errors", () => {
  it("counts a substituted, a dropped and an added word", () => {
    assert.deepEqual(errors("the cat sat on the mat", "the bat sat the mat today", "en"), {
      wrong: 3,
      of: 6,
    });
  });

  it("counts nothing for punctuation-only differences in Mandarin", () => {
    assert.deepEqual(errors("你好，世界。", "你好世界", "zh"), { wrong: 0, of: 4 });
  });

  it("pools wrong tokens over messages", () => {
    assert.equal(
      per100([
        { wrong: 1, of: 10 },
        { wrong: 3, of: 30 },
      ]),
      10,
    );
  });
});
