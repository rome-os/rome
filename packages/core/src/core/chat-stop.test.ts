import { describe, expect, it, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { testTurnHandle } from "../test/turn-handle.js";
import { createChatTurns } from "./chat-turns.js";
import { stopActiveConversationTurn } from "./chat-stop.js";

const ref = {
  connectionId: "connection:discord",
  chatId: "channel-1" as ChatId,
};

function activeTurn() {
  const interrupt = rs.fn(async () => undefined);
  const turn = testTurnHandle({ turnId: "turn-1", events: (async function* () {})(), interrupt });
  const sessions = { turn: (id: string) => (id === turn.id ? turn : undefined) };
  const chatTurns = createChatTurns();
  const end = chatTurns.start(ref, { turnId: "turn-1" });
  return { sessions, chatTurns, interrupt, finish: end };
}

describe("stopActiveConversationTurn", () => {
  it("interrupts the active conversation turn", async () => {
    const { sessions, chatTurns, interrupt } = activeTurn();

    await expect(stopActiveConversationTurn({ ref }, { sessions, chatTurns })).resolves.toEqual({
      status: "stop_requested",
      turnId: "turn-1",
    });
    expect(interrupt).toHaveBeenCalledWith("chat-stop");
  });

  it("reports an idle conversation", async () => {
    const { sessions, chatTurns, interrupt, finish } = activeTurn();
    finish();
    await expect(stopActiveConversationTurn({ ref }, { sessions, chatTurns })).resolves.toEqual({
      status: "idle",
    });
    expect(interrupt).not.toHaveBeenCalled();
  });
});
