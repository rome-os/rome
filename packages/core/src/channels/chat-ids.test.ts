import { describe, expect, it } from "@rstest/core";
import type { ChatId } from "@rome-os/app-runtime";
import { chatKey, notOwnedBy, ownedBy } from "./chat-ids.js";

describe("chat ids", () => {
  it("puts Rome's account in front of a basic group's message ids, and takes it off", () => {
    const basic = chatKey("telegram", "-4242" as ChatId);
    expect(ownedBy(basic, "b1", "55")).toBe("b1:55");
    expect(notOwnedBy(basic, "b1", ownedBy(basic, "b1", "55"))).toBe("55");
    const supergroup = chatKey("telegram", "-1001234567890123" as ChatId);
    expect(ownedBy(supergroup, "b1", "55")).toBe("55");
  });
});
