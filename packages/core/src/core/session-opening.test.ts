import { describe, expect, it } from "@rstest/core";
import {
  dashboardChatAudience,
  sessionOpeningFor,
  talkerChannelSurface,
} from "./session-opening.js";

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
      toolEnv: { ROME_CHANNEL: "webchat", ROME_TURN_AUDIENCE: "private" },
      spanAttributes: { "channel.name": "webchat" },
    });
  });

  it("takes cards from the opener's channel and the rest from the key", () => {
    const opening = openingFor("telegram:42", { channel: "webchat", threadId: "chat-1" });
    expect(opening.drawsCards).toBe(true);
    expect(opening.toolEnv).toEqual({ ROME_CHANNEL: "telegram", ROME_TURN_AUDIENCE: "private" });
  });

  it("states nothing a keyless or unknown conversation would need", () => {
    expect(openingFor("worker:3b1f")).toEqual({
      drawsCards: false,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: "worker", ROME_TURN_AUDIENCE: "shared" },
      spanAttributes: { "channel.name": "worker" },
    });
    expect(openingFor("")).toEqual({
      drawsCards: false,
      guardianFacing: false,
      toolEnv: { ROME_CHANNEL: undefined, ROME_TURN_AUDIENCE: "shared" },
      spanAttributes: {},
    });
  });
});

describe("the audience a session's tools carry", () => {
  const openingFor = sessionOpeningFor({ channelSurface: () => null });
  const audienceOf = (...args: Parameters<typeof openingFor>) =>
    openingFor(...args).toolEnv.ROME_TURN_AUDIENCE;

  it("reads the opener's place: a guardian's direct message is private, a group shared", () => {
    expect(
      audienceOf("telegram:42", {
        channel: "telegram",
        threadId: "42",
        threadType: "private",
        senderBondLevel: "guardian",
      }),
    ).toBe("private");
    expect(
      audienceOf("telegram:-100", {
        channel: "telegram",
        threadId: "-100",
        threadType: "group",
        senderBondLevel: "guardian",
      }),
    ).toBe("shared");
  });

  it("is narrowed by what the opener knows, never widened", () => {
    const dashboard = { channel: "webchat", threadId: "chat-1" };
    expect(audienceOf("webchat:chat-1", dashboard, "shared")).toBe("shared");
    expect(audienceOf("worker:1", undefined, "private")).toBe("shared");
  });

  it("reads a visitor's dashboard chat, or one Rome cannot find, as shared", async () => {
    const repo = (ownerKey: string | null | undefined) => ({
      getSession: async () => (ownerKey === undefined ? null : ({ ownerKey } as never)),
    });
    const dashboard = { channel: "webchat", threadId: "chat-1" };
    expect(await dashboardChatAudience(repo(null), dashboard)).toBe("private");
    expect(await dashboardChatAudience(repo("guardian"), dashboard)).toBe("private");
    expect(await dashboardChatAudience(repo("visitor:acct-1"), dashboard)).toBe("shared");
    expect(await dashboardChatAudience(repo(undefined), dashboard)).toBe("shared");
    expect(await dashboardChatAudience(repo(null), { channel: "telegram", threadId: "1" })).toBe(
      undefined,
    );
  });
});
