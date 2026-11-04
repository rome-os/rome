import { describe, expect, it } from "@rstest/core";
import { messageContentText } from "./messages-agent.js";

describe("messageContentText", () => {
  it("reads a dashboard answer without the narration that led to it", () => {
    const content = JSON.stringify([
      { type: "text", content: "Checking the fares.", turnPhase: "commentary" },
      { type: "task_chat", chatId: "task-1", title: "Flights" },
      { type: "text", content: "3 options", turnPhase: "final" },
    ]);

    expect(messageContentText(content)).toBe("3 options");
  });
});
