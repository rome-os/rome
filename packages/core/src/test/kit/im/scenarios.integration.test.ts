import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { type TestChannel, TEST_CHANNELS, type Platform } from "./test-channel.js";
import { runScenario } from "./scenario.js";

const platforms = Object.keys(TEST_CHANNELS) as Platform[];

// What each adapter does today, recorded so a change to it fails one row. The
// platform's side of each answer comes from the peers, and so from captures.
const TODAY: Record<
  Platform,
  {
    /** The reply points at the user's message. */
    linksReply: boolean;
    /** A 5000-character text: how many characters each message carries, or
     *  the error the send fails with. Null where no capture records a limit. */
    longText: number[] | string | null;
  }
> = {
  telegram: { linksReply: true, longText: "message is too long" },
  // In a DM the adapter sends a plain message; it threads replies only in guild channels.
  discord: { linksReply: false, longText: [2000, 2000, 1000] },
  // iLink has no reply reference, and no capture records its length limit.
  wechat: { linksReply: false, longText: null },
};

describe.each(platforms)("%s", (platform) => {
  let channel: TestChannel;

  beforeEach(async () => {
    channel = await TEST_CHANNELS[platform]();
  });

  afterEach(() => channel.stop());

  it("answers the user in the same conversation", () =>
    runScenario(async ({ step }) => {
      const inbound = await step("The user writes", () => channel.receive("hello"));
      const receipt = await step("Rome answers", () =>
        channel.send({ text: "hi there", replyToMessageId: inbound.messageId }),
      );

      await step("The user sees the answer after their message", () => {
        const [first, second, ...rest] = channel.peer.visible(channel.conversation);
        expect(first).toMatchObject({ from: "user", text: "hello" });
        expect(second).toMatchObject({ id: receipt.messageId, from: "rome" });
        expect(second?.text).toContain("hi there");
        expect(second?.replyTo !== undefined).toBe(TODAY[platform].linksReply);
        expect(rest).toEqual([]);
        channel.peer.server.assertClean();
      });
    }));

  it.skipIf(TODAY[platform].longText === null)("handles a text longer than one message", () =>
    runScenario(async ({ step }) => {
      const expected = TODAY[platform].longText;
      const sending = step("Rome sends 5000 characters", () =>
        channel.send({ text: "a".repeat(5000) }),
      );

      if (typeof expected === "string") {
        await expect(sending).rejects.toThrow(expected);
        await step("The user sees nothing", () =>
          expect(channel.peer.visible(channel.conversation)).toEqual([]),
        );
      } else {
        const receipt = await sending;
        await step("The user sees the text in parts, the receipt naming the first", () => {
          const sent = channel.peer.visible(channel.conversation);
          expect(sent.map((message) => message.text.length)).toEqual(expected);
          expect(receipt.messageId).toBe(sent[0]?.id);
        });
      }
    }),
  );
});
