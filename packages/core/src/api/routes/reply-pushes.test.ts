import { describe, expect, it } from "@rstest/core";
import { replyPushes } from "./webchat.js";

describe("replyPushes", () => {
  it("pushes the reply to a message the guardian or a visitor wrote, signed in", () => {
    expect(replyPushes({ kind: "guardian", userId: "seat", via: "cookie" }, undefined)).toBe(true);
    expect(
      replyPushes({ kind: "visitor", accountId: "acct-v", email: "v@example.com" }, undefined),
    ).toBe(true);
  });

  it("pushes nothing for a loopback caller, an agent account, or no person", () => {
    expect(replyPushes({ kind: "guardian", userId: "seat", via: "loopback" }, undefined)).toBe(
      false,
    );
    expect(
      replyPushes(
        { kind: "visitor", accountId: "acct-v", email: "v@example.com" },
        { platform: "webchat", id: "core:concierge" },
      ),
    ).toBe(false);
    expect(replyPushes({ kind: "anonymous" }, undefined)).toBe(false);
    expect(replyPushes(undefined, undefined)).toBe(false);
  });
});
