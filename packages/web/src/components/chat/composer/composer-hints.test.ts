import { describe, expect, it } from "@rstest/core";
import { composerHints, pickComposerHint } from "./composer-hints";

const desktopDraft = { draft: true, textOnly: false, projectSelector: true, coarsePointer: false };

describe("composerHints", () => {
  it("offers every hint that works in a new chat on a desktop", () => {
    expect(composerHints(desktopDraft)).toEqual([
      "default",
      "skill",
      "agent",
      "project",
      "attach",
      "newline",
      "search",
    ]);
  });

  it("drops the agent and project hints once the chat is open", () => {
    expect(composerHints({ ...desktopDraft, draft: false, projectSelector: false })).toEqual([
      "skill",
      "attach",
      "newline",
      "search",
      "sendWhileWorking",
    ]);
  });

  it("keeps keyboard and drag-and-drop hints off a phone", () => {
    expect(composerHints({ ...desktopDraft, coarsePointer: true })).toEqual([
      "default",
      "skill",
      "agent",
      "project",
    ]);
  });

  it("leaves skills and attachments out of a text-only box", () => {
    expect(composerHints({ ...desktopDraft, draft: false, textOnly: true })).toEqual([
      "newline",
      "search",
      "sendWhileWorking",
    ]);
  });
});

describe("pickComposerHint", () => {
  it("never repeats the hint just shown", () => {
    for (const roll of [0, 0.5, 0.99]) {
      expect(pickComposerHint(["default", "skill"], "default", () => roll)).toBe("skill");
    }
  });

  it("keeps the only hint there is", () => {
    expect(pickComposerHint(["skill"], "skill", () => 0.5)).toBe("skill");
  });

  it("falls back to the default when nothing applies", () => {
    expect(pickComposerHint([], null, () => 0.5)).toBe("default");
  });
});
