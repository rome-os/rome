import { setTimeout as sleep } from "node:timers/promises";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Pacer } from "../../../channels/delivery/pacer.js";
import { ReplyDelivery, type ReplyOutcome } from "../../../channels/delivery/reply.js";
import { effectiveMode } from "../../../channels/delivery/types.js";
import { systemClock } from "../../../lib/clock.js";
import { checkDelivery } from "./invariants.js";
import { runScenario, type ScenarioContext } from "./scenario.js";
import { type Platform, TEST_CHANNELS, type TestChannel } from "./test-channel.js";

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
    /** The test channel carries a reply delivery transport, so a reply can
     *  stream into the conversation. Discord and WeChat have none. */
    streams: boolean;
  }
> = {
  telegram: { linksReply: true, longText: "message is too long", streams: true },
  // In a DM the adapter sends a plain message; it threads replies only in guild channels.
  discord: { linksReply: false, longText: [2000, 2000, 1000], streams: false },
  // iLink has no reply reference, and documents no length limit for the peer to model.
  wechat: { linksReply: false, longText: null, streams: false },
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

  it.skipIf(!TODAY[platform].streams)(
    "streams a commentary and a long answer as the agent writes them",
    ({ task }) => {
      const channel = open();
      return runScenario(task, channel, async (context) => {
        const { outcome, inbound, mode, source } = await streamReply(context, channel);

        await context.step(`The user sees every part, delivered in ${mode} mode`, () => {
          expect(outcome.status).toBe("delivered");
          const messages = romeMessages(channel);
          expect(messages.length).toBeGreaterThanOrEqual(3);
          expect(messages.some((message) => message.edits > 0)).toBe(mode === "edit");
        });
        await context.step("Only the first message answers the user's message", () => {
          const [first, ...rest] = romeMessages(channel);
          expect(first?.replyTo).toBe(TODAY[platform].linksReply ? inbound.messageId : undefined);
          expect(rest.map((message) => message.replyTo)).toEqual(rest.map(() => undefined));
        });
        await context.step("The reply keeps every delivery invariant", () =>
          context.check(
            checkDelivery({
              source,
              outcome,
              peer: channel.peer,
              conversation: channel.conversation,
              maxPartLength: transportOf(channel).capabilities.maxPartLength,
            }),
          ),
        );
      });
    },
  );

  // A platform refuses a message with no visible text, and the refusal would end
  // the reply. The agent's first delta is often only a line break.
  it.skipIf(!TODAY[platform].streams)(
    "waits for visible text when the agent opens with a blank line",
    ({ task }) => {
      const channel = open();
      return runScenario(task, channel, async (context) => {
        const { outcome, source } = await streamReply(context, channel, { lead: "\n\n" });

        await context.step("The reply delivers, and no message opens blank", () => {
          expect(outcome.status).toBe("delivered");
          const [first] = romeMessages(channel);
          expect(first?.text).toBe(COMMENTARY);
        });
        await context.step("The reply keeps every delivery invariant", () =>
          context.check(
            checkDelivery({
              source,
              outcome,
              peer: channel.peer,
              conversation: channel.conversation,
              maxPartLength: transportOf(channel).capabilities.maxPartLength,
            }),
          ),
        );
      });
    },
  );
});

const COMMENTARY = "Let me think of a story first.";
// Long enough for several messages on every platform, with sentence breaks.
const STORY = Array.from(
  { length: 180 },
  (_, i) => `Line ${i + 1}: the quick brown fox jumps over the lazy dog. `,
).join("");

/**
 * Streams a commentary and a long answer from a scripted agent through the
 * test channel's delivery transport, noting what the agent emitted and what
 * Rome wrote. The pacer is wide open: a platform's real budget is the
 * transport's, and this scenario does not test it.
 */
async function streamReply(
  { step, note }: ScenarioContext,
  channel: TestChannel,
  { lead = "" }: { lead?: string } = {},
): Promise<{
  outcome: ReplyOutcome;
  inbound: Awaited<ReturnType<TestChannel["receive"]>>;
  mode: ReturnType<typeof effectiveMode>;
  /** The reply's full text: every block, in order. */
  source: string;
}> {
  const transport = transportOf(channel);
  const policy = {
    mode: "edit" as const,
    editIntervalMs: 20,
    blockWaitMs: 30,
    maxPendingChars: 100_000,
  };
  const inbound = await step("The user writes", () => channel.receive("tell me a story"));
  const delivery = new ReplyDelivery({
    transport,
    pacer: new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, systemClock),
    policy,
    conversation: channel.conversation,
    replyTo: inbound.messageId,
    clock: systemClock,
    observe: (event) =>
      note("rome", `${event.write} part ${event.block}.${event.part}: ${event.result}`, event),
  });
  const emit = (event: StreamAgentEvent) => {
    note("agent", event.type, event);
    delivery.accept(event);
  };

  await step("The agent streams a commentary, then the answer", async () => {
    // With a `lead`, the commentary opens with it, and nothing else arrives
    // for a while, so the engine has seen only whitespace.
    if (lead) {
      emit({ type: "text_delta", content: lead, blockId: "c" });
      await sleep(30);
    }
    emit({ type: "text", content: lead + COMMENTARY, blockId: "c", turnPhase: "commentary" });
    for (const chunk of chunks(STORY, 400)) {
      emit({ type: "text_delta", content: chunk, blockId: "a" });
      await sleep(2);
    }
    emit({ type: "text", content: STORY, blockId: "a", turnPhase: "final" });
    emit({ type: "result", content: STORY });
  });
  const outcome = await step("The reply settles", () => delivery.finish());
  return {
    outcome,
    inbound,
    mode: effectiveMode(policy, transport.capabilities),
    source: lead + COMMENTARY + STORY,
  };
}

function transportOf(channel: TestChannel) {
  if (!channel.delivery) throw new Error(`${channel.platform} has no reply delivery transport`);
  return channel.delivery;
}

function romeMessages(channel: TestChannel) {
  return channel.peer.visible(channel.conversation).filter((message) => message.from === "rome");
}

function chunks(text: string, size: number): string[] {
  return Array.from({ length: Math.ceil(text.length / size) }, (_, i) =>
    text.slice(i * size, (i + 1) * size),
  );
}
