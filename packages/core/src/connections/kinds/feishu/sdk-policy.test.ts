import { describe, expect, it } from "@rstest/core";
import { createLarkChannel } from "./feishu.js";

// The Lark SDK filters group messages before Rome's adapter sees them. This
// runs the real SDK's filter as Rome configures it.

/** The SDK's own verdict on a group message, from the channel Rome builds. */
function sdkAdmits(message: { mentionedBot: boolean; mentionAll?: boolean }): boolean {
  const channel = createLarkChannel({ appId: "cli_test", appSecret: "secret", domain: "feishu" });
  // The SDK keeps its filter inside the channel's safety pipeline.
  const { policy } = (
    channel as unknown as {
      safety: { policy: { evaluate(m: Record<string, unknown>): { allowed: boolean } } };
    }
  ).safety;
  return policy.evaluate({ chatType: "group", chatId: "oc_1", mentionAll: false, ...message })
    .allowed;
}

describe("the Feishu SDK channel", () => {
  it("hands over a group message that does not mention the bot", () => {
    expect(sdkAdmits({ mentionedBot: false })).toBe(true);
  });

  it("hands over a group message that mentions everyone", () => {
    expect(sdkAdmits({ mentionedBot: false, mentionAll: true })).toBe(true);
  });
});
