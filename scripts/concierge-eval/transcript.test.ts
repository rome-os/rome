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

  it("keeps a card the Concierge composed apart from its text, by its plain-text line", () => {
    const card: ChatMessage = {
      id: "card",
      role: "assistant",
      content: JSON.stringify([
        {
          type: "widget",
          toolUseId: "t",
          appId: "core",
          text: "9:00 Belém, 13:00 lunch",
          ui: { components: [{ id: "root", component: "Text", text: "Saturday" }] },
        },
      ]),
      createdAt: "",
    };
    const t = transcriptOf([
      message("user", "plan Saturday"),
      card,
      message("assistant", "Enjoy!"),
    ]);
    expect(t.saidAfter).toEqual([["Enjoy!"]]);
    expect(t.cardsAfter).toEqual([["9:00 Belém, 13:00 lunch"]]);
    expect(t.lines[1]).toContain("showed a card");
  });
});
