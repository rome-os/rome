import { describe, expect, it } from "@rstest/core";
import { ChannelSendRefused, SendRefused, isChannelSendRefused, isSendRefused } from "./index.js";

describe("SendRefused", () => {
  it("names itself SendRefused and carries its reason", () => {
    const refused = new SendRefused("empty", "nothing to send");
    expect(refused.name).toBe("SendRefused");
    expect(refused.reason).toBe("empty");
    expect(isSendRefused(refused)).toBe(true);
  });

  it("recognizes a refusal from a copy older than the rename", () => {
    const legacy = Object.assign(new Error("no quote"), {
      name: "ChannelSendRefused",
      reason: "reply_unaddressable",
    });
    expect(isSendRefused(legacy)).toBe(true);
  });

  it("refuses an error with no reason", () => {
    expect(isSendRefused(Object.assign(new Error("x"), { name: "SendRefused" }))).toBe(false);
  });

  it("keeps the old names working", () => {
    expect(new ChannelSendRefused("empty", "x")).toBeInstanceOf(SendRefused);
    expect(isChannelSendRefused(new SendRefused("empty", "x"))).toBe(true);
  });
});
