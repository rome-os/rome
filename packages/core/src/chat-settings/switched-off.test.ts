import { describe, expect, it, rs } from "@rstest/core";
import type { ChannelMessage, ChatId, ChatSettingsSnapshot } from "@rome-os/app-runtime";
import { DISCORD_CHAT_RULES, SESSION_RESET_ONLY_CHAT_RULES } from "@rome/api-types/chat-rules";
import { heardUnlessSwitchedOff } from "./switched-off.js";

function message(text: string, addressing?: ChannelMessage["addressing"]): ChannelMessage {
  return {
    channel: "discord",
    direction: "inbound",
    messageId: "m1",
    chatId: "c1" as ChatId,
    senderId: "ann",
    text,
    attachments: [],
    timestamp: new Date(0),
    ...(addressing ? { addressing } : {}),
  };
}

function heard(chat: { enabled: boolean; offersEnabled?: boolean }) {
  const get = rs.fn(
    async () =>
      ({
        supportedFields: chat.offersEnabled === false ? [] : ["enabled"],
        effective: { enabled: chat.enabled },
      }) as unknown as ChatSettingsSnapshot,
  );
  const admit = heardUnlessSwitchedOff({
    settings: { get },
    rulesOf: (kind) => (kind === "discord" ? DISCORD_CHAT_RULES : SESSION_RESET_ONLY_CHAT_RULES),
  });
  return { admit, get };
}

describe("a chat switched off", () => {
  it("is not heard, but a stop said to Rome is", async () => {
    const { admit } = heard({ enabled: false });

    const answers = await Promise.all([
      admit("conn-1", "discord", message("hi", "ambient")),
      admit("conn-1", "discord", message("what is left?", "mention")),
      admit("conn-1", "discord", message("/stop", "ambient")),
      admit("conn-1", "discord", message("/stop")),
      admit("conn-1", "discord", message("/stop", "mention")),
      admit("conn-1", "discord", message("/stop", "reply")),
      admit("conn-1", "discord", message("/stop", "bot_thread")),
    ]);

    expect(answers).toEqual([false, false, false, false, true, true, true]);
  });

  it("is heard where the chat cannot be switched off, as a direct message cannot", async () => {
    const { admit } = heard({ enabled: false, offersEnabled: false });

    expect(await admit("conn-1", "discord", message("hi", "direct"))).toBe(true);
  });

  it("reads no settings for a kind whose chats cannot be switched off", async () => {
    const { admit, get } = heard({ enabled: false });

    expect(await admit("conn-1", "telegram", message("hi", "ambient"))).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});

describe("a chat switched on", () => {
  it("is heard", async () => {
    const { admit } = heard({ enabled: true });

    expect(await admit("conn-1", "discord", message("hi", "ambient"))).toBe(true);
  });
});
