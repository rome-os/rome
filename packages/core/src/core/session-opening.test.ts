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

  it("states a web chat's session shows cards, faces the guardian, and carries its channel", async () => {
    expect(await openingFor("webchat:chat-1", { channel: "webchat", threadId: "chat-1" })).toEqual({
      drawsCards: true,
      guardianFacing: true,
      toolEnv: { ROME_CHANNEL: "webchat", ROME_TURN_AUDIENCE: "shared" },
      spanAttributes: { "channel.name": "webchat" },
      audience: "shared",
    });
  });

  it("takes cards from the opener's channel and the rest from the key", async () => {
    const opening = await openingFor("telegram:42", { channel: "webchat", threadId: "chat-1" });
    expect(opening.drawsCards).toBe(true);
    expect(opening.toolEnv).toEqual({ ROME_CHANNEL: "telegram", ROME_TURN_AUDIENCE: "shared" });
  });

  it("states nothing a keyless or unknown conversation would need", async () => {
    expect(await openingFor("worker:3b1f")).toEqual({
      drawsCards: false,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: "worker", ROME_TURN_AUDIENCE: "shared" },
      spanAttributes: { "channel.name": "worker" },
      audience: "shared",
    });
    expect(await openingFor("")).toEqual({
      drawsCards: false,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: undefined, ROME_TURN_AUDIENCE: "shared" },
      spanAttributes: {},
      audience: "shared",
    });
  });
});

describe("the audience a session opens with", () => {
  const openingFor = sessionOpeningFor({
    channelSurface: () => null,
    placeAudience: async (context) => (context?.threadId === "dm" ? "private" : "shared"),
  });

  it("is the place's audience, in the session and in its tools' environment", async () => {
    const dm = await openingFor("telegram:dm", { channel: "telegram", threadId: "dm" });
    expect(dm.audience).toBe("private");
    expect(dm.toolEnv.ROME_TURN_AUDIENCE).toBe("private");
    const group = await openingFor("telegram:g", { channel: "telegram", threadId: "g" });
    expect(group.toolEnv.ROME_TURN_AUDIENCE).toBe("shared");
  });
});
