import { describe, expect, it } from "@rstest/core";
import type { Channel, ChannelMessage, ChatId, InboundEvent } from "@rome-os/app-runtime";
import { markEntered } from "../participation/entrance.js";
import { enteredChannels } from "./entered-channels.js";

describe("enteredChannels", () => {
  it("hands a subscriber only what people let in say", async () => {
    let deliver: (event: InboundEvent) => Promise<void> = async () => {};
    const channel: Channel = {
      name: "slack-2",
      send: null,
      inbound: {
        subscribe: (handler) => {
          deliver = async (event) => handler(event);
          return () => {};
        },
        media: null,
      },
    };
    const [entered] = enteredChannels([channel]);
    const heard: string[] = [];
    entered?.inbound?.subscribe(async ({ message }) => {
      heard.push(message.senderId);
    });
    for (const senderId of ["sam", "ada"]) {
      const chatId = "C1" as ChatId;
      const message: ChannelMessage = {
        channel: "slack-2",
        direction: "inbound",
        messageId: senderId,
        chatId,
        senderId,
        text: "hi",
        attachments: [],
        timestamp: new Date(),
      };
      const event: InboundEvent = { kind: "message", message, ref: { connectionId: "c", chatId } };
      await deliver(markEntered(event, senderId === "ada" ? "Ada" : undefined));
    }
    expect(heard).toEqual(["ada"]);
  });
});
