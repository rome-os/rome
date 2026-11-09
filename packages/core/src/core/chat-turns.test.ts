import { describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { createChatTurns } from "./chat-turns.js";

const chat = {
  connectionId: "connection:discord",
  chatId: "channel-1" as ChatId,
};

describe("ChatTurns", () => {
  it("names the turn running in a chat and who started it until it ends", () => {
    const turns = createChatTurns();
    const end = turns.start(chat, { turnId: "turn-1", initiatorId: "user-1" });

    expect(turns.runningIn(chat)).toEqual({ turnId: "turn-1", initiatorId: "user-1" });

    end();
    expect(turns.runningIn(chat)).toBeUndefined();
  });

  it("does not let an older turn's end clear a newer turn", () => {
    const turns = createChatTurns();
    const endOlder = turns.start(chat, { turnId: "turn-1" });
    turns.start(chat, { turnId: "turn-2" });

    endOlder();
    expect(turns.runningIn(chat)?.turnId).toBe("turn-2");
  });
});
