import { describe, expect, it, rs } from "@rstest/core";
import type { Channel } from "@rome-os/app-runtime";
import { systemClock } from "../../lib/clock.js";
import type { StreamedReply } from "../../connections/chat-adapter.js";
import type { SpeakerReplies } from "../../sessions/speaker-replies.js";
import { ReplyStreams } from "./streams.js";

const target = {
  channel: "telegram",
  romeSessionId: "conversation-1",
  turnId: "turn-1",
};
const telegram = { name: "telegram" } as unknown as Channel;
const settled = {
  outcome: { status: "delivered" as const, parts: [] },
  shown: [{ text: "hi", key: "k", threadId: null }],
};
const opening = () => ({
  accept: rs.fn(),
  stop: rs.fn(),
  settle: rs.fn<StreamedReply["settle"]>(async () => settled),
});
const speakersWith = (stream: SpeakerReplies["stream"]) => ({
  channel: (name: string) => (name === "telegram" ? telegram : undefined),
  replies: { stream },
});

describe("ReplyStreams", () => {
  it("opens no stream while reply streaming is off, and does not ask the speaker", async () => {
    const stream = rs.fn<SpeakerReplies["stream"]>(async () => opening());
    const streams = new ReplyStreams({
      streaming: async () => false,
      clock: systemClock,
      speakers: speakersWith(stream),
    });

    expect(await streams.open(target)).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it("reads the switch each time a reply opens", async () => {
    let on = false;
    const streams = new ReplyStreams({
      streaming: async () => on,
      clock: systemClock,
      speakers: speakersWith(async () => opening()),
    });

    expect(await streams.open(target)).toBeNull();
    on = true;
    expect(await streams.open(target)).not.toBeNull();
  });

  it("opens the speaker's reply on the channel, answering the message by its id", async () => {
    const reply = opening();
    const stream = rs.fn<SpeakerReplies["stream"]>(async () => reply);
    const streams = new ReplyStreams({
      streaming: async () => true,
      clock: systemClock,
      speakers: speakersWith(stream),
    });

    const opened = await streams.open({ ...target, replyTo: 7 });

    expect(stream).toHaveBeenCalledWith(
      target.romeSessionId,
      telegram,
      expect.objectContaining({ turnId: target.turnId, replyTo: 7, clock: systemClock }),
    );
    expect(await opened?.settle(false)).toEqual(settled.outcome);
    expect(reply.settle).toHaveBeenCalledWith(false);
  });

  it("opens nothing where the session stands in no chat, or the channel is gone or cannot stream", async () => {
    const streams = new ReplyStreams({
      streaming: async () => true,
      clock: systemClock,
      speakers: speakersWith(async () => null),
    });

    expect(await streams.open(target)).toBeNull();
    expect(await streams.open({ ...target, channel: "gone" })).toBeNull();
  });
});
