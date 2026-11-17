import { describe, expect, it } from "@rstest/core";
import type { ChatMessage } from "./api.js";
import { transcriptOf } from "./transcript.js";

const message = (role: string, text: string, reaction?: string): ChatMessage => ({
  id: text,
  role,
  content: JSON.stringify([{ type: "text", content: text }]),
  createdAt: "",
  ...(reaction ? { reaction } : {}),
});

describe("transcriptOf", () => {
  it("shows a reaction on an owner message, so it reads unlike no answer", () => {
    const reacted = transcriptOf([message("user", "thanks!", "❤️")]).lines;
    const unanswered = transcriptOf([message("user", "thanks!")]).lines;
    expect(reacted).toEqual(["OWNER: thanks!", "ASSISTANT reacted to that message with ❤️"]);
    expect(unanswered).toEqual(["OWNER: thanks!"]);
  });

  it("keeps the Concierge's text after each owner message", () => {
    const t = transcriptOf([
      message("user", "hi"),
      message("assistant", "Morning!"),
      message("user", "thanks", "🙏"),
    ]);
    expect(t.saidAfter).toEqual([["Morning!"], []]);
    expect(t.reactions).toEqual([null, "🙏"]);
  });
});
