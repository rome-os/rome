import { describe, expect, it } from "@rstest/core";
import { replyPushes, turnActor } from "./webchat.js";

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

describe("turnActor", () => {
  it("is the guardian or visitor who wrote the message, and no one for an agent account", () => {
    const guardian = { kind: "guardian" as const, userId: "seat", via: "loopback" as const };
    const visitor = { kind: "visitor" as const, accountId: "acct-v", email: "v@example.com" };
    expect(turnActor(guardian, undefined)).toBe(guardian);
    expect(turnActor(visitor, undefined)).toBe(visitor);
    expect(turnActor(visitor, { platform: "webchat", id: "core:concierge" })).toBeUndefined();
    expect(turnActor({ kind: "anonymous" }, undefined)).toBeUndefined();
    expect(turnActor(undefined, undefined)).toBeUndefined();
  });
});
