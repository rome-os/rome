import { describe, expect, it } from "@rstest/core";
import { cardKey } from "./live-task-cards";

describe("cardKey", () => {
  it("tells apart two questions a chat asked under the same tool use id", () => {
    expect(cardKey({ kind: "question", id: "tu-1", messageId: "m1" })).not.toBe(
      cardKey({ kind: "question", id: "tu-1", messageId: "m2" }),
    );
    expect(cardKey({ kind: "approval", id: "a1" })).toBe("approval:a1");
  });
});
