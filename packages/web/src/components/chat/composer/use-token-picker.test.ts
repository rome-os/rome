import { describe, expect, it } from "@rstest/core";
import { findMentionToken, findSkillToken } from "./use-token-picker";

describe("findMentionToken", () => {
  it("finds an @ at the start or after whitespace", () => {
    expect(findMentionToken("@res", 4)).toEqual({ start: 0, query: "res" });
    expect(findMentionToken("ask @res now", 8)).toEqual({ start: 4, query: "res" });
  });

  it("ignores an @ inside a word, such as an email address", () => {
    expect(findMentionToken("me@example", 10)).toBeNull();
  });

  it("stops at whitespace before reaching an @", () => {
    expect(findMentionToken("@res now", 8)).toBeNull();
  });
});

describe("findSkillToken", () => {
  it("finds a / at the start of the message", () => {
    expect(findSkillToken("/rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(findSkillToken("/@scope/app", 11)).toEqual({ start: 0, query: "@scope/app" });
  });

  it("ignores a / that is not the first character", () => {
    expect(findSkillToken("run /rev", 8)).toBeNull();
  });

  it("ignores file paths and finished words", () => {
    expect(findSkillToken("/etc/hosts", 10)).toBeNull();
    expect(findSkillToken("/rev now", 8)).toBeNull();
  });
});
