import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { type Platform, TEST_CHANNELS, type TestChannel } from "./test-channel.js";
import { runScenario } from "./scenario.js";

const platforms = Object.keys(TEST_CHANNELS) as Platform[];

// What each adapter does today, recorded so a change to it fails one row. The
// platform's side of each answer comes from the peers: captured shapes, and
// for these limits, synthetic refusals modeled on the platform's documentation.
// Null where a peer models no limit.
const TODAY: Record<
  Platform,
  {
    /** The reply points at the user's message. */
    linksReply: boolean;
    /** A 5000-character text: how many characters each message carries, or
     *  the error the send fails with. Null where the peer models no limit. */
    longText: number[] | string | null;
  }
> = {
  telegram: { linksReply: true, longText: "message is too long" },
  // In a DM the adapter sends a plain message; it threads replies only in guild channels.
  discord: { linksReply: false, longText: [2000, 2000, 1000] },
  // iLink has no reply reference, and documents no length limit for the peer to model.
  wechat: { linksReply: false, longText: null },
};

describe.each(platforms)("%s", (platform) => {
  let channel: TestChannel | undefined;
  const open = () => {
    if (!channel) throw new Error("The test channel did not start");
    return channel;
  };

  beforeEach(async () => {
    channel = await TEST_CHANNELS[platform]();
  });

  // Every request, teardown's included, must be one the peer models.
  afterEach(async () => {
    const stopping = channel;
    channel = undefined;
    try {
      await stopping?.stop();
    } finally {
      stopping?.peer.server.assertClean();
    }
  });

  it("answers the user in the same conversation", ({ task }) => {
    const channel = open();
    return runScenario(task, channel, async ({ step }) => {
      const inbound = await step("The user writes", () => channel.receive("hello"));
      const receipt = await step("Rome answers", () =>
        channel.send({ text: "hi there", replyToMessageId: inbound.messageId }),
      );

      await step("The user sees the answer after their message", () => {
        const [first, second, ...rest] = channel.peer.visible(channel.conversation);
        expect(inbound.conversationId).toBe(channel.conversation);
        expect(receipt.conversationId).toBe(channel.conversation);
        expect(first).toMatchObject({ id: inbound.messageId, from: "user", text: "hello" });
        expect(second).toMatchObject({ id: receipt.messageId, from: "rome" });
        expect(second?.text).toContain("hi there");
        expect(second?.replyTo).toBe(TODAY[platform].linksReply ? inbound.messageId : undefined);
        expect(rest).toEqual([]);
      });
    });
  });

  it.skipIf(TODAY[platform].longText === null)(
    "handles a text longer than one message",
    ({ task }) => {
      const channel = open();
      return runScenario(task, channel, async ({ step }) => {
        const expected = TODAY[platform].longText;
        // WeChat can answer only after the user writes, so every platform starts there.
        await step("The user writes", () => channel.receive("tell me everything"));
        const fromRome = () =>
          channel.peer.visible(channel.conversation).filter((message) => message.from === "rome");
        const send = () => channel.send({ text: "a".repeat(5000) });

        if (typeof expected === "string") {
          await step("The platform refuses 5000 characters", () =>
            expect(send()).rejects.toThrow(expected),
          );
          await step("The user sees no answer", () => expect(fromRome()).toEqual([]));
        } else {
          const receipt = await step("Rome sends 5000 characters", send);
          await step("The user sees the text in parts, the receipt naming the first", () => {
            const sent = fromRome();
            expect(sent.map((message) => message.text.length)).toEqual(expected);
            expect(receipt.messageId).toBe(sent[0]?.id);
          });
        }
      });
    },
  );
});
