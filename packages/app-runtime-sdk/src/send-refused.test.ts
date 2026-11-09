import { describe, expect, it } from "@rstest/core";
import { ChannelSendRefused, SendRefused, isChannelSendRefused, isSendRefused } from "./index.js";

describe("SendRefused", () => {
  it("carries its reason, under the name an older SDK matches", () => {
    const refused = new SendRefused("empty", "nothing to send");
    expect(refused.name).toBe("ChannelSendRefused");
    expect(refused.reason).toBe("empty");
    expect(isSendRefused(refused)).toBe(true);
  });

  it("recognizes a refusal from an older copy, and one named SendRefused", () => {
    for (const name of ["ChannelSendRefused", "SendRefused"]) {
      const refused = Object.assign(new Error("no quote"), { name, reason: "reply_unaddressable" });
      expect(isSendRefused(refused)).toBe(true);
    }
  });

  it("is recognized by the guard of an SDK older than the rename", () => {
    // The guard 0.10.0 shipped, which an app bundling that copy still runs.
    const olderGuard = (error: unknown) =>
      error instanceof Error &&
      error.name === "ChannelSendRefused" &&
      typeof (error as { reason?: unknown }).reason === "string";
    expect(olderGuard(new SendRefused("attachment_unsupported", "no files here"))).toBe(true);
  });

  it("refuses an error with no reason", () => {
    expect(isSendRefused(Object.assign(new Error("x"), { name: "ChannelSendRefused" }))).toBe(
      false,
    );
  });

  it("keeps the old names working", () => {
    expect(new ChannelSendRefused("empty", "x")).toBeInstanceOf(SendRefused);
    expect(isChannelSendRefused(new SendRefused("empty", "x"))).toBe(true);
  });
});
