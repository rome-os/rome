import { describe, expect, it, rs } from "@rstest/core";
import { systemClock } from "../../lib/clock.js";
import { Pacer } from "./pacer.js";
import { ReplyStreams } from "./streams.js";
import { DeliveryFailure, type DeliveryTransport, plainText } from "./types.js";

const budget = { burst: 100, refillMs: 1, conversationSpacingMs: 0 };
const transport: DeliveryTransport = {
  capabilities: { maxPartLength: 5, edit: false, budget },
  codec: plainText,
  create: async (conversation, text) => ({
    messageId: `id-${text.trim()}`,
    chatId: conversation,
  }),
};
const target = {
  channel: "telegram",
  chatId: "chat-1",
  replyToMessageId: "msg-1",
  romeSessionId: "conversation-1",
  turnId: "turn-1",
};
const replies = () => ({ transport, pacer: new Pacer(budget, systemClock) });

describe("ReplyStreams", () => {
  it("opens no stream while reply streaming is off, and does not look at the channel", async () => {
    const lookup = rs.fn(replies);
    const streams = new ReplyStreams({
      streaming: async () => false,
      replies: lookup,
      clock: systemClock,
    });

    expect(await streams.open(target)).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("opens no stream on a channel that cannot stream", async () => {
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies: () => null,
      clock: systemClock,
    });
    expect(await streams.open(target)).toBeNull();
  });

  it("reads the switch each time a reply opens", async () => {
    let on = false;
    const streams = new ReplyStreams({
      streaming: async () => on,
      replies,
      clock: systemClock,
    });

    expect(await streams.open(target)).toBeNull();
    on = true;
    expect(await streams.open(target)).not.toBeNull();
  });

  it("records the delivered reply once, as the text the user was shown", async () => {
    const recordOutboundMessage = rs.fn(async () => undefined);
    const chats = { recordOutboundMessage };
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies,
      clock: systemClock,
      chats,
    });
    const stream = (await streams.open(target))!;

    stream.accept({ type: "result", content: "one two" });
    const outcome = await stream.settle(false);

    expect(outcome.status).toBe("delivered");
    expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "conversation-1",
        content: JSON.stringify([{ type: "text", content: "one two" }]),
        platformMessageId: "id-one",
        replyToPlatformMessageId: "msg-1",
        turnId: "turn-1",
      }),
    );
  });

  it("records each block as its own paragraph, under the first message of the last block", async () => {
    const recordOutboundMessage = rs.fn(async () => undefined);
    const chats = { recordOutboundMessage };
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies,
      clock: systemClock,
      chats,
    });
    const stream = (await streams.open(target))!;

    stream.accept({ type: "text", content: "one two" });
    stream.accept({ type: "text", content: "six", turnPhase: "final" });
    stream.accept({ type: "result", content: "six" });
    await stream.settle(false);

    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: JSON.stringify([{ type: "text", content: "one two\n\nsix" }]),
        platformMessageId: "id-six",
      }),
    );
  });

  it("records the reply under the last block with a message id, when the answer's create is unknown", async () => {
    const recordOutboundMessage = rs.fn(async () => undefined);
    const chats = { recordOutboundMessage };
    const answerUnknown: DeliveryTransport = {
      ...transport,
      create: async (conversation, text) => {
        if (text === "six") throw new DeliveryFailure("unknown", "no answer");
        return { messageId: `id-${text.trim()}`, chatId: conversation };
      },
    };
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies: () => ({ transport: answerUnknown, pacer: new Pacer(budget, systemClock) }),
      clock: systemClock,
      chats,
    });
    const stream = (await streams.open(target))!;

    stream.accept({ type: "text", content: "one two" });
    stream.accept({ type: "text", content: "six", turnPhase: "final" });
    stream.accept({ type: "result", content: "six" });
    expect((await stream.settle(false)).status).toBe("unknown");

    expect(recordOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: JSON.stringify([{ type: "text", content: "one two\n\nsix" }]),
        platformMessageId: "id-one",
      }),
    );
  });

  it("shows the answer WebChat shows, for a structured result and for a turn that ends mid-block", async () => {
    const recordOutboundMessage = rs.fn(async () => undefined);
    const chats = { recordOutboundMessage };
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies,
      clock: systemClock,
      chats,
    });
    const shown = () =>
      recordOutboundMessage.mock.calls.map(
        (call) =>
          (
            JSON.parse((call as unknown as [{ content: string }])[0].content) as [
              { content: string },
            ]
          )[0].content,
      );

    // An agent with an output schema streams no text. Its answer is the
    // result's JSON.
    const structured = (await streams.open(target))!;
    structured.accept({ type: "result", content: '{"ok":true}' });
    await structured.settle(false);

    // A turn can end before its block's text event. The text that streamed is
    // the answer, and the result repeats it.
    const cut = (await streams.open(target))!;
    cut.accept({ type: "text_delta", content: "one " });
    cut.accept({ type: "text_delta", content: "two" });
    cut.accept({ type: "result", content: "one two" });
    await cut.settle(false);

    expect(shown()).toEqual(['{"ok":true}', "one two"]);
  });

  it("records nothing when no message was written, so a failed stream leaves no history", async () => {
    const recordOutboundMessage = rs.fn(async () => undefined);
    const chats = { recordOutboundMessage };
    const refusing: DeliveryTransport = {
      ...transport,
      create: async () => {
        throw new DeliveryFailure("rejected", "refused");
      },
    };
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies: () => ({ transport: refusing, pacer: new Pacer(budget, systemClock) }),
      clock: systemClock,
      chats,
    });
    const stream = (await streams.open(target))!;

    stream.accept({ type: "result", content: "one" });
    expect((await stream.settle(false)).status).toBe("failed");
    expect(recordOutboundMessage).not.toHaveBeenCalled();
  });

  it("records a message whose create may have landed, since nothing sends it again", async () => {
    const recordOutboundMessage = rs.fn(async () => undefined);
    const chats = { recordOutboundMessage };
    const unanswered: DeliveryTransport = {
      ...transport,
      create: async () => {
        throw new DeliveryFailure("unknown", "no answer");
      },
    };
    const streams = new ReplyStreams({
      streaming: async () => true,
      replies: () => ({ transport: unanswered, pacer: new Pacer(budget, systemClock) }),
      clock: systemClock,
      chats,
    });
    const stream = (await streams.open(target))!;

    stream.accept({ type: "result", content: "one" });
    expect((await stream.settle(false)).status).toBe("unknown");
    expect(recordOutboundMessage).toHaveBeenCalledTimes(1);
    const [recorded] = recordOutboundMessage.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(recorded).toMatchObject({
      content: JSON.stringify([{ type: "text", content: "one" }]),
      turnId: "turn-1",
    });
    expect(recorded).not.toHaveProperty("platformMessageId");
  });
});
