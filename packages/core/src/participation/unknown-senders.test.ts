import { describe, expect, it } from "@rstest/core";
import type { ChatId, InboundEvent } from "@rome-os/app-runtime";
import { type Arrival, markArrival } from "./entrance.js";
import { type UnknownSenderMessage, unknownSenders } from "./unknown-senders.js";

const SAM = { platform: "slack", id: "T1/U9" };
const recorded = { id: 7, saidBy: { account: SAM } };

function event(
  arrival: Partial<Arrival> | null = {},
  fields: Partial<InboundEvent["message"]> = {},
  connectionId = "rome-app",
): InboundEvent {
  const chatId = "C1" as ChatId;
  const heard: InboundEvent = {
    kind: "message",
    message: {
      channel: "slack_app",
      direction: "inbound",
      messageId: "1.2",
      chatId,
      senderId: SAM.id,
      text: "hi",
      attachments: [],
      timestamp: new Date(),
      addressing: "mention",
      ...fields,
    },
    ref: { connectionId, chatId },
  };
  return arrival === null
    ? heard
    : markArrival(heard, { entry: { kind: "unknown" }, automated: false, ...arrival });
}

function teller(tell = async (_message: UnknownSenderMessage) => {}) {
  const told: UnknownSenderMessage[] = [];
  const hear = unknownSenders({
    isRomes: (account) => account.id === "T1/UROME",
    isOwnAccount: (connectionId) => connectionId.startsWith("rome-app"),
    heardForMs: 60_000,
    tell: async (message) => {
      told.push(message);
      await tell(message);
    },
  });
  return { hear, told };
}

describe("unknownSenders", () => {
  it("tells of a message to Rome from a sender nobody holds, with where to answer it", () => {
    const { hear, told } = teller();
    hear(recorded, event());
    expect(told).toEqual([
      {
        messageId: 7,
        sender: SAM,
        connectionId: "rome-app",
        channel: "slack_app",
        chatId: "C1",
        platformMessageId: "1.2",
        addressing: "mention",
      },
    ]);
  });

  it("tells of a message once, for the first of Rome's accounts it addresses", () => {
    const { hear, told } = teller();
    hear(recorded, event({}, { addressing: "ambient" }, "rome-app-1"));
    hear(recorded, event({}, {}, "rome-app-2"));
    hear(recorded, event({}, {}, "rome-app-3"));
    expect(told.map((message) => message.connectionId)).toEqual(["rome-app-2"]);
  });

  it("tells of a message once, however many are told of before it is heard again", () => {
    const { hear, told } = teller();
    for (let id = 1; id <= 5_000; id += 1) hear({ ...recorded, id }, event());
    hear({ ...recorded, id: 1 }, event({}, {}, "rome-app-2"));
    expect(told).toHaveLength(5_000);
  });

  it.each<[string, InboundEvent]>([
    ["someone let in said", event({ entry: { kind: "entered", person: "Ada" } })],
    ["someone refused said", event({ entry: { kind: "refused" } })],
    ["no entrance saw", event(null)],
    ["a bot or an app posted", event({ automated: true })],
    ["addresses nobody", event({}, { addressing: "ambient" })],
    ["Rome cannot tell whom it addresses", event({}, { addressing: undefined })],
    ["reached the guardian's own account", event({}, {}, "guardian-whatsapp")],
  ])("tells of no message %s", (_what, heard) => {
    const { hear, told } = teller();
    hear(recorded, heard);
    expect(told).toEqual([]);
  });

  it("tells of no message one of Rome's accounts said", () => {
    const { hear, told } = teller();
    hear({ id: 7, saidBy: { account: { platform: "slack", id: "T1/UROME" } } }, event());
    expect(told).toEqual([]);
  });

  it("waits for nothing, and a failure reaches no one and is not tried again", async () => {
    const { hear, told } = teller(async () => {
      throw new Error("the platform refused");
    });
    hear(recorded, event());
    await Promise.resolve();
    hear(recorded, event());
    expect(told).toHaveLength(1);
  });
});
