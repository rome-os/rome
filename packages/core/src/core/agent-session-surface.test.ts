import { describe, expect, it } from "@rstest/core";
import { talkerChannelSurface } from "./agent-session.js";

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
