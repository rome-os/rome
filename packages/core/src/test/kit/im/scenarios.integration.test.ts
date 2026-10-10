import { setTimeout as sleep } from "node:timers/promises";
import type { StreamAgentEvent } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it } from "@rstest/core";
import { Pacer } from "../../../channels/delivery/pacer.js";
import { ReplyDelivery, type ReplyOutcome } from "../../../channels/delivery/reply.js";
import { type DeliveryTransport, effectiveMode } from "../../../channels/delivery/types.js";
import { systemClock } from "../../../lib/clock.js";
import { checkDelivery } from "./invariants.js";
import { runScenario, type ScenarioContext } from "./scenario.js";
import { TELEGRAM_TOKEN } from "./telegram.js";
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

// The request of a platform's API that a scenario holds in flight and then cuts
// off, so the platform applies it and the client never hears. Null where no
// transport streams.
const EDIT_REQUEST: Record<Platform, string | null> = {
  telegram: `/bot${TELEGRAM_TOKEN}/editMessageText`,
  discord: null,
  wechat: null,
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

  // An edit the platform applies but whose answer never arrives leaves the
  // client not knowing what the message shows. If the block then completes
  // back to the text the client last saw acknowledged, the reply must still
  // put that text back, not take the old text as settled.
  it.skipIf(EDIT_REQUEST[platform] === null)(
    "puts the final text back after an edit whose answer was lost",
    ({ task }) => {
      const channel = open();
      return runScenario(task, channel, async (context) => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const { outcome } = await streamScript(context, channel, async ({ emit }) => {
          emit({ type: "text_delta", content: "Hello", blockId: "a" });
          await channel.peer.server.waitFor((e) => e.accepted);
          // The next edit reaches the platform and waits there, applies, and loses its answer.
          channel.peer.server.once({
            method: "POST",
            path: EDIT_REQUEST[platform]!,
            before: () => held,
            dropAfterAccept: true,
          });
          emit({ type: "text_delta", content: " world", blockId: "a" });
          await channel.peer.server.waitFor((e) => e.request.path === EDIT_REQUEST[platform]);
          // The block completes back to what the client last saw acknowledged.
          emit({ type: "text", content: "Hello", blockId: "a", turnPhase: "final" });
          release();
        });

        await context.step("The user sees the final text, and the reply delivered", () => {
          expect(outcome.status).toBe("delivered");
          expect(romeMessages(channel).map((message) => message.text)).toEqual(["Hello"]);
        });
        await context.step("The lost edit had been applied before it was put back", () => {
          const texts = channel.peer
            .changes(channel.conversation)
            .filter((change) => change.message.from === "rome")
            .map((change) => change.message.text);
          expect(texts).toEqual(["Hello", "Hello world", "Hello"]);
        });
      });
    },
  );

  // A complete text can come out shorter than the deltas it replaces. A message
  // the reply already settled stays as it is, since the platform refuses an
  // edit to nothing, and the reply reports it as differing.
  it.skipIf(!TODAY[platform].streams)(
    "keeps messages it already settled when the final text is shorter than what streamed",
    ({ task }) => {
      const channel = open();
      return runScenario(task, channel, async (context) => {
        const { outcome } = await streamScript(
          context,
          channel,
          async ({ emit }) => {
            emit({
              type: "text_delta",
              content: "aaaa bbbb cccc dddd eeee ffff gggg hhhh",
              blockId: "a",
            });
            // The shorter text must arrive once the platform shows the parts it
            // will leave as they are, however long the round trips take.
            await channel.peer.server.waitFor(() => romeMessages(channel).length >= 3, 10_000);
            emit({ type: "text", content: "aaaa", blockId: "a", turnPhase: "final" });
          },
          { maxPartLength: 12 },
        );

        await context.step("The platform refused no request, and the reply delivered", () => {
          const refused = channel.peer.server.exchanges.filter(
            (e) => (e.response?.status ?? 0) >= 400,
          );
          expect(refused).toEqual([]);
          expect(outcome.status).toBe("delivered");
        });
        await context.step("The later messages stay as they were, reported as differing", () => {
          expect(romeMessages(channel).length).toBeGreaterThanOrEqual(3);
          expect(outcome.parts.length).toBeGreaterThanOrEqual(3);
          expect(outcome.parts.slice(1).every((part) => part.diverged === true)).toBe(true);
          expect(outcome.diverged).toBe(true);
        });
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
    const [first, ...rest] = chunks(STORY, 400);
    emit({ type: "text_delta", content: first!, blockId: "a" });
    // The answer's preview must be on the platform before the rest arrives. With
    // slow round trips the whole answer could otherwise complete first and settle
    // as creates, and nothing would be edited.
    await channel.peer.server.waitFor(() => romeMessages(channel).length >= 2, 10_000);
    for (const chunk of rest) {
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

/**
 * Streams the reply `script` writes, from a scripted agent, through the test
 * channel's delivery transport. The script gets `emit`, which notes the event
 * on the agent's lane and gives it to the engine. `maxPartLength` narrows the
 * platform's limit so a short text makes several messages.
 */
async function streamScript(
  { step, note }: ScenarioContext,
  channel: TestChannel,
  script: (tools: { emit: (event: StreamAgentEvent) => void }) => Promise<void>,
  { maxPartLength }: { maxPartLength?: number } = {},
): Promise<{ outcome: ReplyOutcome }> {
  const wide = transportOf(channel);
  const transport: DeliveryTransport = maxPartLength
    ? { ...wide, capabilities: { ...wide.capabilities, maxPartLength } }
    : wide;
  await step("The user writes", () => channel.receive("tell me something"));
  const delivery = new ReplyDelivery({
    transport,
    pacer: new Pacer({ burst: 1000, refillMs: 1, conversationSpacingMs: 0 }, systemClock),
    policy: { mode: "edit", editIntervalMs: 0, blockWaitMs: 0, maxPendingChars: 100_000 },
    conversation: channel.conversation,
    clock: systemClock,
    observe: (event) =>
      note("rome", `${event.write} part ${event.block}.${event.part}: ${event.result}`, event),
  });
  await step("The agent streams its reply", () =>
    script({
      emit: (event) => {
        note("agent", event.type, event);
        delivery.accept(event);
      },
    }),
  );
  const outcome = await step("The reply settles", () => delivery.finish());
  return { outcome };
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
