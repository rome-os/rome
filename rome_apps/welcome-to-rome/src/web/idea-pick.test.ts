import { describe, expect, it } from "@rstest/core";
import { pickIdea } from "./idea-pick.js";

const idea = { title: "Launch tracker", prompt: "Build me a launch tracker." };

describe("pickIdea", () => {
  it("stays in this chat on a card that builds there", () => {
    expect(pickIdea({ ideas: [idea], buildInChat: true }, idea)).toEqual({
      result: { ideaTitle: "Launch tracker" },
      draft: null,
    });
  });

  it.each([
    ["shown without an AI", { ideas: [idea], buildInChat: false }],
    ["from before the build moved into this chat", { ideas: [idea] }],
  ])("opens a drafted chat, and says so, on a card %s", (_label, props) => {
    expect(pickIdea(props, idea)).toEqual({
      result: { ideaTitle: "Launch tracker", openedDraft: true },
      draft: "Build me a launch tracker.",
    });
  });
});
