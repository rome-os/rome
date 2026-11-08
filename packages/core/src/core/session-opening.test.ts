import { describe, expect, it } from "@rstest/core";
import { sessionOpeningFor, talkerChannelSurface } from "./session-opening.js";

describe("talkerChannelSurface", () => {
  it("reads an omitted fact as a messaging channel's", () => {
    expect(talkerChannelSurface({})).toEqual({ interactiveCards: false, promptContext: true });
  });

  it("keeps the facts a talker declares", () => {
    expect(talkerChannelSurface({ interactiveCards: true, promptContext: false })).toEqual({
      interactiveCards: true,
      promptContext: false,
    });
  });
});

describe("sessionOpeningFor", () => {
  const surfaces = (channel: string) =>
    channel === "webchat"
      ? { interactiveCards: true, promptContext: false }
      : channel === "telegram"
        ? { interactiveCards: false, promptContext: true }
        : null;
  const openingFor = sessionOpeningFor({ channelSurface: surfaces });

  it("states a web chat's session shows cards, faces the guardian, and carries its channel", () => {
    expect(openingFor("webchat:chat-1", { channel: "webchat", threadId: "chat-1" })).toEqual({
      drawsCards: true,
      guardianFacing: true,
      toolEnv: { ROME_CHANNEL: "webchat" },
      spanAttributes: { "channel.name": "webchat" },
    });
  });

  it("takes cards from the opener's channel and the rest from the key", () => {
    const opening = openingFor("telegram:42", { channel: "webchat", threadId: "chat-1" });
    expect(opening.drawsCards).toBe(true);
    expect(opening.toolEnv).toEqual({ ROME_CHANNEL: "telegram" });
  });

  it("states nothing a keyless or unknown conversation would need", () => {
    expect(openingFor("worker:3b1f")).toEqual({
      drawsCards: false,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: "worker" },
      spanAttributes: { "channel.name": "worker" },
    });
    expect(openingFor("")).toEqual({
      drawsCards: false,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: undefined },
      spanAttributes: {},
    });
  });
});
