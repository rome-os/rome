import { describe, expect, it, rs } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { testTurnHandle } from "../test/turn-handle.js";
import { createChatTurns } from "./chat-turns.js";
import { stopActiveConversationTurn, stopSenderPlatform } from "./chat-stop.js";

const ref = {
  connectionId: "connection:discord",
  chatId: "channel-1" as ChatId,
};

function activeTurn(initiatorId = "user-1") {
  const interrupt = rs.fn(async () => undefined);
  const turn = testTurnHandle({ turnId: "turn-1", events: (async function* () {})(), interrupt });
  const sessions = { turn: (id: string) => (id === turn.id ? turn : undefined) };
  const chatTurns = createChatTurns();
  const end = chatTurns.start(ref, { turnId: "turn-1", initiatorId });
  return { sessions, chatTurns, interrupt, finish: end };
}

describe("stopActiveConversationTurn", () => {
  it("interrupts the active conversation turn for its initiator", async () => {
    const { sessions, chatTurns, interrupt } = activeTurn();
    const isGuardian = rs.fn(async () => false);

    await expect(
      stopActiveConversationTurn(
        { ref, service: "discord", senderId: "user-1" },
        { sessions, chatTurns, isGuardian },
      ),
    ).resolves.toEqual({ status: "stop_requested", turnId: "turn-1" });
    expect(interrupt).toHaveBeenCalledWith("chat-stop");
    expect(isGuardian).not.toHaveBeenCalled();
  });

  it("allows a guardian to stop another sender's turn", async () => {
    const { sessions, chatTurns, interrupt } = activeTurn("owner");

    await expect(
      stopActiveConversationTurn(
        { ref, service: "discord", senderId: "guardian" },
        { sessions, chatTurns, isGuardian: async () => true },
      ),
    ).resolves.toMatchObject({ status: "stop_requested", turnId: "turn-1" });
    expect(interrupt).toHaveBeenCalledTimes(1);
  });

  it("rejects another sender and reports an idle conversation", async () => {
    const { sessions, chatTurns, interrupt, finish } = activeTurn("owner");
    const options = { sessions, chatTurns, isGuardian: async () => false };

    await expect(
      stopActiveConversationTurn({ ref, service: "discord", senderId: "other" }, options),
    ).resolves.toEqual({ status: "forbidden" });
    expect(interrupt).not.toHaveBeenCalled();

    finish();
    await expect(
      stopActiveConversationTurn({ ref, service: "discord", senderId: "owner" }, options),
    ).resolves.toEqual({ status: "idle" });
  });
});

describe("stopSenderPlatform", () => {
  const OPAQUE = "c7d1a0e2-5b3f-4e8a-9c61-2f0b7d4e8a13";
  const platformOfChannel = (channel: string) => (channel === OPAQUE ? "lark" : channel);

  it("takes the platform of the account the chat's connection reaches", () => {
    expect(
      stopSenderPlatform(ref, OPAQUE, {
        accountOf: () => ({ platform: "feishu", id: "cli_rome" }),
        platformOfChannel,
      }),
    ).toBe("feishu");
  });

  it("reads an opaque channel as a channel while the grant names no account", () => {
    expect(stopSenderPlatform(ref, OPAQUE, { accountOf: () => null, platformOfChannel })).toBe(
      "lark",
    );
  });
});
