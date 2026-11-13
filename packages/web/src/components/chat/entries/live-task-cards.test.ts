import { describe, expect, it } from "@rstest/core";
import { cardKey, isOpenWait } from "./live-task-cards";

describe("cardKey", () => {
  it("tells apart two questions a chat asked under the same tool use id", () => {
    expect(cardKey({ kind: "question", id: "tu-1", messageId: "m1" })).not.toBe(
      cardKey({ kind: "question", id: "tu-1", messageId: "m2" }),
    );
    expect(cardKey({ kind: "approval", id: "a1" })).toBe("approval:a1");
  });
});

describe("isOpenWait", () => {
  const card = {
    kind: "question" as const,
    id: "tu-1",
    messageId: "m-old",
    render: null,
    since: 1,
    expired: false,
  };
  it("takes a historical card for no newer question asked under its tool use id", () => {
    const newer = { kind: "card" as const, id: "tu-1", messageId: "m-new", render: null, since: 2 };
    expect(isOpenWait(newer, card)).toBe(false);
    expect(isOpenWait({ ...newer, messageId: "m-old" }, card)).toBe(true);
  });
  it("matches an approval by its id alone, and never a question by an approval's", () => {
    const approval = { kind: "approval" as const, id: "a1", title: "Send", since: 1 };
    expect(isOpenWait({ kind: "approval", id: "a1", since: 1 }, approval)).toBe(true);
    expect(isOpenWait({ kind: "approval", id: "tu-1", since: 1 }, card)).toBe(false);
  });
});
