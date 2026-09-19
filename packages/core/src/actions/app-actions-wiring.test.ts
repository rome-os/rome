import { describe, expect, it } from "@rstest/core";
import { sharedDepsForAppAction } from "./app-actions-wiring.js";

describe("app action runtime dependency boundary", () => {
  const talkRouter = {
    send: async () => ({ conversationId: "arbitrary" }),
    list: async () => [],
  };

  it("does not grant ordinary app actions broad TalkRouter targeting", () => {
    const deps = sharedDepsForAppAction("third-party-app", { talkRouter, harmless: true });

    expect(deps).toEqual({ harmless: true });
    expect("talkRouter" in deps).toBe(false);
  });

  it("retains TalkRouter only for the explicit internal system app", () => {
    expect(sharedDepsForAppAction("system", { talkRouter })).toEqual({ talkRouter });
  });
});
