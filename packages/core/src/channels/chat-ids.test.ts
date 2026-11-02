import { describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import {
  chatKey,
  directMessageKey,
  directMessageOn,
  notOwnedBy,
  otherEndOf,
  ownedBy,
} from "./chat-ids.js";

describe("chat keys", () => {
  it("names a direct message by its two ends, and reads the other end back", () => {
    const key = directMessageKey("feishu", "ou_bot", "ou_alice");
    expect(otherEndOf(key)).toBe("ou_alice");
    expect(directMessageKey("feishu", "ou_bot_2", "ou_alice")).not.toEqual(key);
    expect(otherEndOf(chatKey("feishu", "oc_group" as ChatId))).toBeNull();
  });

  it("keys a direct message by the other party where the platform addresses it so", () => {
    expect(directMessageOn("telegram", "bot", "42", "ignored")).toEqual(
      directMessageKey("telegram", "bot", "42"),
    );
    expect(directMessageOn("feishu", "ou_bot", "oc_p2p", "ou_alice")).toEqual(
      directMessageKey("feishu", "ou_bot", "ou_alice"),
    );
    expect(directMessageOn("email", "rome@example.com", "thread-1", "alice")).toEqual(
      chatKey("email", "thread-1" as ChatId),
    );
  });

  it("puts Rome's account in front of a basic group's message keys, and takes it off", () => {
    const basic = chatKey("telegram", "-4242" as ChatId);
    expect(ownedBy(basic, "b1", "55")).toBe("b1:55");
    expect(notOwnedBy(basic, "b1", ownedBy(basic, "b1", "55"))).toBe("55");
    const supergroup = chatKey("telegram", "-1001234567890123" as ChatId);
    expect(ownedBy(supergroup, "b1", "55")).toBe("55");
  });
});
